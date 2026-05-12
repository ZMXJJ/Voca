"""Install the CUDA PyTorch runtime into Voca's bundled Windows venv.

This module implements the multi-stage flow described in the Windows support
plan:

  * ``DownloadStage`` — resumable + SHA-256-verified fetch of ``torch`` and
    ``torchaudio`` wheels from the PyTorch public index.
  * ``InstallStage``  — extract the wheels into ``runtime/staging/``, run a
    sub-process import self-check, then atomically move the new ``torch`` and
    ``torchaudio`` directories into ``site-packages/``. If a previous runtime
    exists it is preserved under ``runtime/rollback/<timestamp>/`` first. If the
    post-swap validation fails, the rollback is restored automatically.

All operations are idempotent and interruption-safe:

  * partially written ``*.whl.partial`` files are resumed via HTTP ``Range``.
  * corrupt downloads are detected through a whole-file SHA-256 check and
    retried up to ``MAX_DOWNLOAD_ATTEMPTS`` times.
  * the ``upgrade.lock`` file guarantees at most one concurrent upgrade.
  * on failure any fully-downloaded wheel is kept so the next attempt starts
    right at the install stage.
"""

from __future__ import annotations

import html
import hashlib
import json
import logging
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterable

try:
    import certifi  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    certifi = None  # type: ignore

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover - requests is a transitive dep of huggingface_hub
    requests = None  # type: ignore

from app.services._speed import EmaSpeedTracker
from app.services.storage_paths import app_support_dir
from app.services.provider_router import prefer_cn_downloads

logger = logging.getLogger(__name__)

PYTORCH_INDEX_BASE_OFFICIAL = "https://download.pytorch.org/whl/cu124"
PYTORCH_INDEX_BASE_ALIYUN = "https://mirrors.aliyun.com/pytorch-wheels/cu124"
TORCH_VERSION = "2.6.0"
TORCH_LOCAL_VARIANT = "cu124"
MAX_DOWNLOAD_ATTEMPTS = 3
DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024  # 4 MiB
DOWNLOAD_TIMEOUT_SECONDS = 120
TORCH_SEGMENT_THREADS = 32
PROGRESS_EMIT_INTERVAL_SECONDS = 0.2
REQUEST_HEADERS = {"User-Agent": "Voca-Desktop-Upgrader"}
RUNTIME_SITE_PACKAGES_ENV = "VOCA_RUNTIME_SITE_PACKAGES"
RUNTIME_COMPLETE_MARKER_FILENAME = "cuda-runtime-complete.json"
_WEAK_CERT_ERROR_MARKERS = (
    "ee certificate key too weak",
    "ca certificate key too weak",
    "certificate key too weak",
)


ProgressCallback = Callable[[dict], None]


class CudaUpgradeError(RuntimeError):
    """Raised for any unrecoverable upgrade failure."""


@dataclass(frozen=True)
class WheelSpec:
    package: str  # e.g. "torch" or "torchaudio"
    filename: str
    url: str
    sha256: str | None
    source_name: str
    source_label: str | None = None


@dataclass(frozen=True)
class WheelSource:
    name: str
    label: str
    index_base: str
    package_subdirs: bool = False


OFFICIAL_WHEEL_SOURCE = WheelSource(
    name="official",
    label="PyTorch",
    index_base=PYTORCH_INDEX_BASE_OFFICIAL,
    package_subdirs=True,
)
ALIYUN_WHEEL_SOURCE = WheelSource(
    name="aliyun",
    label="Aliyun",
    index_base=PYTORCH_INDEX_BASE_ALIYUN,
    package_subdirs=False,
)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def runtime_root() -> Path:
    root = app_support_dir() / "runtime"
    root.mkdir(parents=True, exist_ok=True)
    return root


def downloads_dir() -> Path:
    directory = runtime_root() / "downloads"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def staging_dir() -> Path:
    directory = runtime_root() / "staging"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def rollback_root() -> Path:
    directory = runtime_root() / "rollback"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def runtime_json_path() -> Path:
    return runtime_root() / "runtime.json"


def upgrade_lock_path() -> Path:
    return runtime_root() / "upgrade.lock"


def runtime_site_packages_dir() -> Path:
    explicit = os.environ.get(RUNTIME_SITE_PACKAGES_ENV, "").strip()
    if explicit:
        directory = Path(explicit).expanduser()
    else:
        directory = runtime_root() / "site-packages"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def runtime_complete_marker_path() -> Path:
    return runtime_root() / RUNTIME_COMPLETE_MARKER_FILENAME


def has_runtime_complete_marker() -> bool:
    marker = runtime_complete_marker_path()
    if not marker.exists():
        return False
    site_packages = runtime_site_packages_dir()
    return (site_packages / "torch").exists() and (site_packages / "torchaudio").exists()


def write_runtime_complete_marker(*, backend: str, self_check: dict | None = None) -> None:
    payload = {
        "backend": backend,
        "installedAt": datetime.now(UTC).isoformat(),
        "sitePackagesDir": str(runtime_site_packages_dir()),
    }
    if self_check:
        payload["selfCheck"] = self_check
    marker_path = runtime_complete_marker_path()
    tmp_path = marker_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(marker_path)


def current_venv_python() -> Path:
    """Return the interpreter running this process.

    The bundled Windows sidecar runs with the python-build-standalone interpreter
    from ``python-runtime`` and augments imports via ``PYTHONPATH`` to point at
    ``python-service/.venv/Lib/site-packages``. For subprocess self-checks we
    still want the actual interpreter executable, which is ``sys.executable``.
    """

    return Path(sys.executable)


def _service_site_packages_from_env() -> Path | None:
    explicit_runtime_site_packages = os.environ.get(RUNTIME_SITE_PACKAGES_ENV, "").strip()
    if explicit_runtime_site_packages:
        candidate = Path(explicit_runtime_site_packages).expanduser()
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate.resolve()

    service_root = os.environ.get("VOCA_PYTHON_SERVICE_ROOT", "").strip()
    if service_root:
        candidate = Path(service_root).expanduser() / ".venv" / "Lib" / "site-packages"
        if candidate.exists():
            return candidate.resolve()

    python_path = os.environ.get("PYTHONPATH")
    if python_path:
        for entry in python_path.split(os.pathsep):
            text = entry.strip()
            if not text:
                continue
            candidate = Path(text).expanduser()
            try:
                resolved = candidate.resolve()
            except Exception:
                continue
            if resolved.name.lower() == "site-packages" and resolved.exists():
                return resolved

    return None


def current_site_packages() -> Path:
    """Resolve the writable site-packages directory used by the sidecar.

    In bundled Windows builds the interpreter lives under ``python-runtime`` but
    third-party packages live under ``python-service/.venv/Lib/site-packages`` and
    are injected through ``PYTHONPATH`` by the Tauri launcher. Installing into the
    interpreter's own ``Lib/site-packages`` would target the bundled resources
    directory and fail with ``WinError 5``.
    """

    if sys.platform == "win32":
        return runtime_site_packages_dir().resolve()

    service_site_packages = _service_site_packages_from_env()
    if service_site_packages is not None:
        return service_site_packages

    # site.getsitepackages gives us every search path; the venv one typically contains
    # "site-packages" and lives under the venv root so filter on that.
    try:
        import site

        candidates: list[str] = []
        if hasattr(site, "getsitepackages"):
            candidates.extend(site.getsitepackages())
        user_packages = site.getusersitepackages() if hasattr(site, "getusersitepackages") else None
        if user_packages:
            candidates.append(user_packages)
    except Exception as exc:
        raise CudaUpgradeError(f"unable to resolve site-packages: {exc}") from exc

    venv_prefix = Path(sys.prefix).resolve()
    for candidate in candidates:
        candidate_path = Path(candidate).resolve()
        try:
            candidate_path.relative_to(venv_prefix)
        except ValueError:
            continue
        if candidate_path.name.lower() == "site-packages":
            return candidate_path

    # Fallback: synthesize the layout expected for the platform.
    if sys.platform == "win32":
        return venv_prefix / "Lib" / "site-packages"
    return venv_prefix / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"


# ---------------------------------------------------------------------------
# Lock file
# ---------------------------------------------------------------------------


class UpgradeLockBusy(RuntimeError):
    """Raised when another process already holds ``upgrade.lock``."""


@contextmanager
def upgrade_lock():
    """Best-effort cross-platform exclusive lock for the upgrade pipeline."""

    lock_path = upgrade_lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if sys.platform == "win32":  # pragma: no cover - Windows only
            import msvcrt

            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise UpgradeLockBusy("another upgrade is already running") from exc
        else:
            import fcntl

            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise UpgradeLockBusy("another upgrade is already running") from exc

        os.write(fd, f"{os.getpid()}\n".encode("utf-8"))
        yield
    finally:
        try:
            if sys.platform == "win32":  # pragma: no cover - Windows only
                import msvcrt

                try:
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                import fcntl

                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
        finally:
            os.close(fd)


# ---------------------------------------------------------------------------
# Wheel discovery
# ---------------------------------------------------------------------------


def _python_tag() -> str:
    version = sys.version_info
    return f"cp{version.major}{version.minor}"


def _platform_tag() -> str:
    if sys.platform == "win32":
        return "win_amd64"
    if sys.platform == "darwin":
        # Only for dev / testing on macOS; CUDA wheels do not exist for darwin.
        arch = "arm64" if os.uname().machine == "arm64" else "x86_64"
        return f"macosx_14_0_{arch}"
    return "linux_x86_64"


def _ensure_requests():
    if requests is None:
        raise CudaUpgradeError(
            "the `requests` package is not available; cannot fetch CUDA wheels"
        )


def _looks_like_weak_cert_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _WEAK_CERT_ERROR_MARKERS)


if requests is not None:
    _WEAK_TLS_HOSTS: set[str] = set()
    _WEAK_TLS_HOSTS_LOCK = threading.Lock()

    def _request_hostname(url: str) -> str:
        return urllib.parse.urlparse(url).hostname or ""


    def _remember_weak_tls_host(url: str) -> None:
        hostname = _request_hostname(url)
        if not hostname:
            return
        with _WEAK_TLS_HOSTS_LOCK:
            _WEAK_TLS_HOSTS.add(hostname)


    def _is_weak_tls_host(url: str) -> bool:
        hostname = _request_hostname(url)
        if not hostname:
            return False
        with _WEAK_TLS_HOSTS_LOCK:
            return hostname in _WEAK_TLS_HOSTS


    def _resolve_verify_setting(explicit_verify):
        if explicit_verify is not None:
            return explicit_verify

        for env_name in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
            env_value = os.environ.get(env_name, "").strip()
            if env_value:
                return env_value

        if certifi is not None:
            try:
                return certifi.where()
            except Exception:
                pass

        return True


    class _TLSHttpAdapter(requests.adapters.HTTPAdapter):  # type: ignore[misc]
        """HTTP adapter that can lower the OpenSSL security level for weak cert chains.

        Some Windows environments in China are behind TLS interception appliances or
        mirrors whose certificate chain is accepted by the system trust store but is
        rejected by OpenSSL 3.x at its default security level with
        ``EE certificate key too weak``. Retrying with ``SECLEVEL=1`` keeps
        verification enabled while allowing those legacy keys.
        """

        def __init__(self, *, allow_weak_keys: bool = False, verify_setting=None, **kwargs) -> None:
            self._allow_weak_keys = allow_weak_keys
            self._verify_setting = verify_setting
            super().__init__(**kwargs)

        def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
            pool_kwargs["ssl_context"] = self._build_ssl_context()
            return super().init_poolmanager(connections, maxsize, block, **pool_kwargs)

        def proxy_manager_for(self, proxy, **proxy_kwargs):
            proxy_kwargs["ssl_context"] = self._build_ssl_context()
            return super().proxy_manager_for(proxy, **proxy_kwargs)

        def _build_ssl_context(self) -> ssl.SSLContext:
            verify_setting = _resolve_verify_setting(self._verify_setting)
            if verify_setting is False:
                context = ssl._create_unverified_context()
            else:
                cafile = verify_setting if isinstance(verify_setting, str) and not os.path.isdir(verify_setting) else None
                capath = verify_setting if isinstance(verify_setting, str) and os.path.isdir(verify_setting) else None
                context = ssl.create_default_context(cafile=cafile, capath=capath)
            if self._allow_weak_keys:
                try:
                    context.set_ciphers("DEFAULT@SECLEVEL=1")
                except ssl.SSLError:
                    logger.warning("unable to lower OpenSSL security level for weak-cert retry")
            return context


    def _request_with_weak_tls(
        method: str,
        url: str,
        **kwargs,
    ):
        verify_setting = kwargs.get("verify")
        session = requests.Session()
        adapter = _TLSHttpAdapter(
            allow_weak_keys=True,
            verify_setting=verify_setting,
        )
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        if verify_setting is not None:
            session.verify = verify_setting
        try:
            return session.request(method, url, **kwargs)
        finally:
            session.close()


def _request(
    method: str,
    url: str,
    *,
    allow_weak_cert_retry: bool = True,
    **kwargs,
):
    _ensure_requests()

    if allow_weak_cert_retry and requests is not None and _is_weak_tls_host(url):
        return _request_with_weak_tls(method, url, **kwargs)

    try:
        return requests.request(method, url, **kwargs)
    except requests.exceptions.SSLError as exc:
        if not allow_weak_cert_retry or not _looks_like_weak_cert_error(exc):
            raise

        _remember_weak_tls_host(url)
        logger.warning(
            "SSL verification hit weak certificate chain for %s; retrying with OpenSSL SECLEVEL=1",
            url,
        )
        return _request_with_weak_tls(method, url, **kwargs)


def _wheel_source_order() -> tuple[WheelSource, ...]:
    if prefer_cn_downloads():
        return (ALIYUN_WHEEL_SOURCE, OFFICIAL_WHEEL_SOURCE)
    return (OFFICIAL_WHEEL_SOURCE, ALIYUN_WHEEL_SOURCE)


def _index_url(package: str, source: WheelSource) -> str:
    base = source.index_base.rstrip("/")
    if source.package_subdirs:
        return f"{base}/{package}/"
    return f"{base}/"


_HREF_PATTERN = re.compile(r'href="([^"]+)"', re.IGNORECASE)


def discover_wheels() -> list[WheelSpec]:
    """Return the list of wheel specs required to move to the CUDA runtime."""

    _ensure_requests()

    python_tag = _python_tag()
    platform_tag = _platform_tag()
    errors: list[str] = []

    for source in _wheel_source_order():
        wheels: list[WheelSpec] = []
        try:
            for package in ("torch", "torchaudio"):
                index_url = _index_url(package, source)
                logger.info(
                    "fetching pytorch index from %s: %s",
                    source.label,
                    index_url,
                )
                response = _request("GET", index_url, headers=REQUEST_HEADERS, timeout=30)
                response.raise_for_status()
                wheels.append(
                    _select_wheel(
                        package,
                        index_url,
                        response.text,
                        python_tag,
                        platform_tag,
                        source=source,
                    )
                )
            logger.info("selected CUDA wheel source: %s", source.label)
            return wheels
        except Exception as exc:
            message = f"{source.label}: {exc}"
            logger.warning("CUDA wheel discovery failed for %s: %s", source.label, exc)
            errors.append(message)

    raise CudaUpgradeError(
        "unable to locate CUDA wheels from any configured source: "
        + " | ".join(errors)
    )


def _select_wheel(
    package: str,
    index_url: str,
    html_text: str,
    python_tag: str,
    platform_tag: str,
    *,
    source: WheelSource,
) -> WheelSpec:
    expected_version_fragment = f"-{TORCH_VERSION}+{TORCH_LOCAL_VARIANT}-"
    expected_tags = f"-{python_tag}-{python_tag}-{platform_tag}.whl"

    best: tuple[str, str, str | None] | None = None
    for match in _HREF_PATTERN.finditer(html_text):
        href = html.unescape(match.group(1))
        split = href.split("#", 1)
        path_part = split[0]
        fragment = split[1] if len(split) == 2 else ""

        filename = urllib.parse.unquote(path_part.rsplit("/", 1)[-1])
        if not filename.startswith(f"{package}-"):
            continue
        if expected_version_fragment not in filename:
            continue
        if not filename.endswith(expected_tags):
            continue

        url = urllib.parse.urljoin(index_url, path_part)

        sha256: str | None = None
        for item in fragment.split("&"):
            if item.startswith("sha256="):
                sha256 = item.split("=", 1)[1].lower()
                break

        best = (filename, url, sha256)
        break

    if best is None:
        raise CudaUpgradeError(
            f"no wheel found for {package} {TORCH_VERSION}+{TORCH_LOCAL_VARIANT} "
            f"matching {python_tag}/{platform_tag} from {source.label}"
        )

    filename, url, sha256 = best
    return WheelSpec(
        package=package,
        filename=filename,
        url=url,
        sha256=sha256,
        source_name=source.name,
        source_label=source.label,
    )


# ---------------------------------------------------------------------------
# Download stage
# ---------------------------------------------------------------------------


@dataclass
class DownloadResult:
    wheels: list[Path]
    bytes_downloaded: int
    wheel_specs: list[WheelSpec]


class _SegmentedDownloadFallback(RuntimeError):
    """Raised when segmented downloading should fall back to the legacy path."""


class _SegmentProgressTracker:
    """Thread-safe aggregate progress reporter for segmented downloads."""

    def __init__(
        self,
        part_count: int,
        total_bytes: int,
        callback: Callable[[int, int | None], None] | None,
    ) -> None:
        self._part_sizes = [0] * part_count
        self._total_downloaded = 0
        self._total_bytes = total_bytes
        self._callback = callback
        self._lock = threading.Lock()
        self._last_emit_at = 0.0

    def set_part_size(self, index: int, size: int, *, force: bool = False) -> None:
        if self._callback is None:
            return

        emit_total: int | None = None
        now = time.monotonic()
        with self._lock:
            previous = self._part_sizes[index]
            if previous == size and not force:
                return

            self._part_sizes[index] = size
            self._total_downloaded += size - previous
            should_emit = force or (now - self._last_emit_at) >= PROGRESS_EMIT_INTERVAL_SECONDS
            if should_emit:
                self._last_emit_at = now
                emit_total = self._total_downloaded

        if emit_total is not None:
            self._callback(emit_total, self._total_bytes)

    def emit_now(self) -> None:
        if self._callback is None:
            return
        with self._lock:
            self._last_emit_at = time.monotonic()
            total_downloaded = self._total_downloaded
        self._callback(total_downloaded, self._total_bytes)


def _sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _segmented_parts_dir(destination_dir: Path, wheel: WheelSpec) -> Path:
    return destination_dir / f"{wheel.filename}.parts"


def _discover_wheel_total_bytes(
    wheel: WheelSpec,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> int | None:
    if cancel_check and cancel_check():
        raise CudaUpgradeError("download cancelled")

    try:
        response = _request(
            "HEAD",
            wheel.url,
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
            headers=REQUEST_HEADERS,
            allow_redirects=True,
        )
        try:
            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            if content_length:
                size = int(content_length)
                if size > 0:
                    return size
        finally:
            response.close()
    except Exception as exc:
        logger.debug("HEAD size probe failed for %s: %s", wheel.filename, exc)

    try:
        headers = dict(REQUEST_HEADERS)
        headers["Range"] = "bytes=0-0"
        response = _request(
            "GET",
            wheel.url,
            stream=True,
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
            headers=headers,
            allow_redirects=True,
        )
        try:
            if response.status_code == 206:
                content_range = response.headers.get("Content-Range", "").strip()
                match = re.match(r"bytes\s+\d+-\d+/(\d+)", content_range, flags=re.IGNORECASE)
                if match is not None:
                    size = int(match.group(1))
                    if size > 0:
                        return size

            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            if content_length:
                size = int(content_length)
                if size > 0:
                    return size
        finally:
            response.close()
    except Exception as exc:
        logger.debug("GET size probe failed for %s: %s", wheel.filename, exc)

    return None


def _probe_range_download(
    wheel: WheelSpec,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    if cancel_check and cancel_check():
        raise CudaUpgradeError("download cancelled")

    headers = dict(REQUEST_HEADERS)
    headers["Range"] = "bytes=0-0"
    with _request(
        "GET",
        wheel.url,
        stream=True,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
        headers=headers,
        allow_redirects=True,
    ) as response:
        if response.status_code != 206:
            raise _SegmentedDownloadFallback(
                f"range requests are not supported for {wheel.filename} from {wheel.source_label or wheel.source_name}"
            )

        content_range = response.headers.get("Content-Range", "").strip()
        match = re.match(r"bytes\s+\d+-\d+/(\d+)", content_range, flags=re.IGNORECASE)
        if match is None:
            raise _SegmentedDownloadFallback(
                f"range probe returned unreadable Content-Range for {wheel.filename}: {content_range!r}"
            )

        total_bytes = int(match.group(1))
        if total_bytes <= 0:
            raise _SegmentedDownloadFallback(
                f"range probe reported invalid size for {wheel.filename}: {total_bytes}"
            )
        return total_bytes


def _segment_ranges(total_bytes: int, segment_count: int) -> list[tuple[int, int]]:
    segment_count = max(1, min(segment_count, total_bytes))
    chunk_size, remainder = divmod(total_bytes, segment_count)
    ranges: list[tuple[int, int]] = []
    start = 0
    for index in range(segment_count):
        size = chunk_size + (1 if index < remainder else 0)
        end = start + size - 1
        ranges.append((start, end))
        start = end + 1
    return ranges


def _segment_part_paths(parts_dir: Path, part_count: int) -> list[Path]:
    return [parts_dir / f"part-{index:03d}.partial" for index in range(part_count)]


def _cleanup_stale_segment_parts(parts_dir: Path, active_paths: Iterable[Path]) -> None:
    if not parts_dir.exists():
        return

    active_names = {path.name for path in active_paths}
    for path in parts_dir.iterdir():
        if path.is_file() and path.name not in active_names:
            path.unlink(missing_ok=True)


def _cleanup_segmented_artifacts(parts_dir: Path, partial_path: Path | None = None) -> None:
    if partial_path is not None:
        partial_path.unlink(missing_ok=True)

    if not parts_dir.exists():
        return

    shutil.rmtree(parts_dir, ignore_errors=True)


def _copy_n_bytes(source, destination, count: int) -> None:
    remaining = count
    while remaining > 0:
        chunk = source.read(min(1024 * 1024, remaining))
        if not chunk:
            raise CudaUpgradeError("unexpected EOF while migrating partial download into segments")
        destination.write(chunk)
        remaining -= len(chunk)


def _migrate_monolithic_partial_to_segments(
    partial_path: Path,
    part_paths: list[Path],
    ranges: list[tuple[int, int]],
) -> None:
    if not partial_path.exists():
        return

    partial_size = partial_path.stat().st_size
    if partial_size <= 0:
        partial_path.unlink(missing_ok=True)
        return

    part_paths[0].parent.mkdir(parents=True, exist_ok=True)
    with partial_path.open("rb") as source:
        remaining = partial_size
        for part_path, (start, end) in zip(part_paths, ranges, strict=False):
            if remaining <= 0:
                break

            expected_size = end - start + 1
            to_copy = min(expected_size, remaining)
            with part_path.open("wb") as destination:
                _copy_n_bytes(source, destination, to_copy)
            remaining -= to_copy

    partial_path.unlink(missing_ok=True)


def _merge_segment_parts(
    part_paths: list[Path],
    ranges: list[tuple[int, int]],
    partial_path: Path,
) -> None:
    partial_path.parent.mkdir(parents=True, exist_ok=True)
    with partial_path.open("wb") as merged:
        for part_path, (start, end) in zip(part_paths, ranges, strict=False):
            expected_size = end - start + 1
            actual_size = part_path.stat().st_size if part_path.exists() else 0
            if actual_size != expected_size:
                raise CudaUpgradeError(
                    f"segment {part_path.name} has size {actual_size}, expected {expected_size}"
                )
            with part_path.open("rb") as source:
                shutil.copyfileobj(source, merged, length=1024 * 1024)


def _maybe_complete_from_partial(
    partial_path: Path,
    final_path: Path,
    wheel: WheelSpec,
    *,
    expected_size: int,
    on_bytes: Callable[[int, int | None], None] | None = None,
) -> bool:
    if not partial_path.exists():
        return False

    actual_size = partial_path.stat().st_size
    if actual_size != expected_size:
        return False

    if wheel.sha256 is not None:
        actual_sha = _sha256_of(partial_path)
        if actual_sha != wheel.sha256:
            partial_path.unlink(missing_ok=True)
            return False

    partial_path.replace(final_path)
    if on_bytes is not None:
        on_bytes(expected_size, expected_size)
    return True


def _download_wheel_single_connection(
    wheel: WheelSpec,
    destination_dir: Path,
    *,
    on_bytes: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    destination_dir.mkdir(parents=True, exist_ok=True)
    final_path = destination_dir / wheel.filename
    partial_path = destination_dir / f"{wheel.filename}.partial"

    if final_path.exists():
        if wheel.sha256 is None or _sha256_of(final_path) == wheel.sha256:
            if on_bytes is not None:
                size = final_path.stat().st_size
                on_bytes(size, size)
            return final_path
        logger.warning("existing wheel %s failed sha256; re-downloading", wheel.filename)
        final_path.unlink(missing_ok=True)

    last_error: Exception | None = None
    for attempt in range(1, MAX_DOWNLOAD_ATTEMPTS + 1):
        if cancel_check and cancel_check():
            raise CudaUpgradeError("download cancelled")

        try:
            existing = partial_path.stat().st_size if partial_path.exists() else 0
            headers = dict(REQUEST_HEADERS)
            if existing:
                headers["Range"] = f"bytes={existing}-"

            with _request(
                "GET",
                wheel.url,
                stream=True,
                timeout=DOWNLOAD_TIMEOUT_SECONDS,
                headers=headers,
                allow_redirects=True,
            ) as response:
                if response.status_code in (200, 206):
                    total_from_header = response.headers.get("Content-Length")
                    total_bytes: int | None = None
                    if total_from_header is not None:
                        try:
                            total_bytes = int(total_from_header) + (
                                existing if response.status_code == 206 else 0
                            )
                        except ValueError:
                            total_bytes = None
                    if response.status_code == 200 and existing:
                        # Server ignored the range — restart.
                        existing = 0
                        partial_path.unlink(missing_ok=True)

                    mode = "ab" if response.status_code == 206 else "wb"
                    downloaded = existing
                    with partial_path.open(mode) as handle:
                        for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_BYTES):
                            if cancel_check and cancel_check():
                                raise CudaUpgradeError("download cancelled")
                            if not chunk:
                                continue
                            handle.write(chunk)
                            downloaded += len(chunk)
                            if on_bytes is not None:
                                on_bytes(downloaded, total_bytes)
                else:
                    response.raise_for_status()

            if wheel.sha256 is not None:
                actual = _sha256_of(partial_path)
                if actual != wheel.sha256:
                    partial_path.unlink(missing_ok=True)
                    raise CudaUpgradeError(
                        f"sha256 mismatch for {wheel.filename}: expected {wheel.sha256}, got {actual}"
                    )

            partial_path.replace(final_path)
            return final_path
        except CudaUpgradeError:
            raise
        except Exception as exc:  # noqa: BLE001 — we retry any transient failure
            last_error = exc
            logger.warning(
                "download attempt %d/%d for %s failed: %s",
                attempt,
                MAX_DOWNLOAD_ATTEMPTS,
                wheel.filename,
                exc,
            )
            time.sleep(min(2 ** attempt, 10))

    raise CudaUpgradeError(
        f"failed to download {wheel.filename} after {MAX_DOWNLOAD_ATTEMPTS} attempts: {last_error}"
    )


def _download_segment_part(
    wheel: WheelSpec,
    part_path: Path,
    *,
    part_index: int,
    start: int,
    end: int,
    tracker: _SegmentProgressTracker,
    cancel_check: Callable[[], bool] | None,
    abort_event: threading.Event,
) -> None:
    expected_size = end - start + 1
    existing = part_path.stat().st_size if part_path.exists() else 0

    if existing > expected_size:
        part_path.unlink(missing_ok=True)
        existing = 0

    tracker.set_part_size(part_index, existing, force=(existing == expected_size))
    if existing == expected_size:
        return

    last_error: Exception | None = None
    for attempt in range(1, MAX_DOWNLOAD_ATTEMPTS + 1):
        if abort_event.is_set():
            raise CudaUpgradeError("download aborted")
        if cancel_check and cancel_check():
            abort_event.set()
            raise CudaUpgradeError("download cancelled")

        try:
            headers = dict(REQUEST_HEADERS)
            headers["Range"] = f"bytes={start + existing}-{end}"
            with _request(
                "GET",
                wheel.url,
                stream=True,
                timeout=DOWNLOAD_TIMEOUT_SECONDS,
                headers=headers,
                allow_redirects=True,
            ) as response:
                if response.status_code != 206:
                    raise _SegmentedDownloadFallback(
                        f"server ignored range request for {wheel.filename} segment {part_index}"
                    )

                content_range = response.headers.get("Content-Range", "").strip()
                expected_prefix = f"bytes {start + existing}-"
                if not content_range.lower().startswith(expected_prefix.lower()):
                    raise CudaUpgradeError(
                        f"unexpected Content-Range for {wheel.filename} segment {part_index}: {content_range!r}"
                    )

                mode = "ab" if existing else "wb"
                with part_path.open(mode) as handle:
                    for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_BYTES):
                        if abort_event.is_set():
                            raise CudaUpgradeError("download aborted")
                        if cancel_check and cancel_check():
                            abort_event.set()
                            raise CudaUpgradeError("download cancelled")
                        if not chunk:
                            continue
                        handle.write(chunk)
                        existing += len(chunk)
                        tracker.set_part_size(part_index, existing)

            if existing != expected_size:
                raise CudaUpgradeError(
                    f"segment {part_index} incomplete for {wheel.filename}: got {existing}, expected {expected_size}"
                )

            tracker.set_part_size(part_index, existing, force=True)
            return
        except (_SegmentedDownloadFallback, CudaUpgradeError):
            raise
        except Exception as exc:  # noqa: BLE001 — retry resumably
            last_error = exc
            existing = part_path.stat().st_size if part_path.exists() else 0
            tracker.set_part_size(part_index, existing, force=True)
            logger.warning(
                "segment attempt %d/%d for %s part %d failed: %s",
                attempt,
                MAX_DOWNLOAD_ATTEMPTS,
                wheel.filename,
                part_index,
                exc,
            )
            time.sleep(min(2 ** attempt, 10))

    raise CudaUpgradeError(
        f"failed to download segment {part_index} for {wheel.filename} after {MAX_DOWNLOAD_ATTEMPTS} attempts: {last_error}"
    )


def _download_wheel_segmented(
    wheel: WheelSpec,
    destination_dir: Path,
    *,
    on_bytes: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    destination_dir.mkdir(parents=True, exist_ok=True)
    final_path = destination_dir / wheel.filename
    partial_path = destination_dir / f"{wheel.filename}.partial"
    parts_dir = _segmented_parts_dir(destination_dir, wheel)

    if final_path.exists():
        if wheel.sha256 is None or _sha256_of(final_path) == wheel.sha256:
            if on_bytes is not None:
                size = final_path.stat().st_size
                on_bytes(size, size)
            return final_path
        logger.warning("existing wheel %s failed sha256; re-downloading", wheel.filename)
        final_path.unlink(missing_ok=True)

    total_bytes = _probe_range_download(wheel, cancel_check=cancel_check)
    if _maybe_complete_from_partial(
        partial_path,
        final_path,
        wheel,
        expected_size=total_bytes,
        on_bytes=on_bytes,
    ):
        return final_path

    ranges = _segment_ranges(total_bytes, TORCH_SEGMENT_THREADS)
    part_paths = _segment_part_paths(parts_dir, len(ranges))
    parts_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_segment_parts(parts_dir, part_paths)

    if partial_path.exists() and partial_path.stat().st_size > total_bytes:
        logger.warning("discarding oversized partial download for %s", wheel.filename)
        partial_path.unlink(missing_ok=True)

    existing_segment_parts = any(path.exists() for path in part_paths)
    if partial_path.exists() and not existing_segment_parts:
        logger.info("migrating monolithic partial download into segmented parts for %s", wheel.filename)
        _migrate_monolithic_partial_to_segments(partial_path, part_paths, ranges)
    elif partial_path.exists():
        partial_path.unlink(missing_ok=True)

    tracker = _SegmentProgressTracker(len(part_paths), total_bytes, on_bytes)
    for index, (part_path, (start, end)) in enumerate(zip(part_paths, ranges, strict=False)):
        expected_size = end - start + 1
        existing = part_path.stat().st_size if part_path.exists() else 0
        if existing > expected_size:
            part_path.unlink(missing_ok=True)
            existing = 0
        tracker.set_part_size(index, existing, force=False)
    tracker.emit_now()

    abort_event = threading.Event()
    executor = ThreadPoolExecutor(max_workers=len(part_paths), thread_name_prefix="voca-cuda")
    futures = {
        executor.submit(
            _download_segment_part,
            wheel,
            part_path,
            part_index=index,
            start=start,
            end=end,
            tracker=tracker,
            cancel_check=cancel_check,
            abort_event=abort_event,
        ): index
        for index, (part_path, (start, end)) in enumerate(zip(part_paths, ranges, strict=False))
    }

    fallback_error: _SegmentedDownloadFallback | None = None
    regular_error: Exception | None = None
    try:
        for future in as_completed(futures):
            exc = future.exception()
            if exc is None:
                continue
            abort_event.set()
            if isinstance(exc, _SegmentedDownloadFallback):
                fallback_error = fallback_error or exc
            else:
                regular_error = regular_error or exc
    finally:
        if abort_event.is_set():
            for future in futures:
                future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)

    if fallback_error is not None:
        raise fallback_error
    if regular_error is not None:
        raise regular_error

    _merge_segment_parts(part_paths, ranges, partial_path)
    if wheel.sha256 is not None:
        actual_sha = _sha256_of(partial_path)
        if actual_sha != wheel.sha256:
            _cleanup_segmented_artifacts(parts_dir, partial_path)
            raise CudaUpgradeError(
                f"sha256 mismatch for {wheel.filename}: expected {wheel.sha256}, got {actual_sha}"
            )

    partial_path.replace(final_path)
    tracker.emit_now()
    _cleanup_segmented_artifacts(parts_dir)
    return final_path


def download_wheel(
    wheel: WheelSpec,
    destination_dir: Path,
    *,
    on_bytes: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Download ``wheel`` resumably into ``destination_dir`` and SHA-256 verify it.

    Returns the final wheel path on disk.
    """

    _ensure_requests()
    if wheel.package == "torch":
        try:
            return _download_wheel_segmented(
                wheel,
                destination_dir,
                on_bytes=on_bytes,
                cancel_check=cancel_check,
            )
        except _SegmentedDownloadFallback as exc:
            _cleanup_segmented_artifacts(_segmented_parts_dir(destination_dir, wheel))
            logger.warning("segmented download unavailable for %s; falling back: %s", wheel.filename, exc)

    return _download_wheel_single_connection(
        wheel,
        destination_dir,
        on_bytes=on_bytes,
        cancel_check=cancel_check,
    )


class DownloadStage:
    """Download ``torch`` and ``torchaudio`` CUDA wheels with progress reporting."""

    def __init__(
        self,
        *,
        progress: ProgressCallback | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> None:
        self._progress = progress
        self._cancel_check = cancel_check
        # Single tracker spanning both wheels — what the UI cares about is
        # the aggregate transfer rate, not the per-wheel rate. The 32-way
        # segmented producer already throttles emissions to
        # ``PROGRESS_EMIT_INTERVAL_SECONDS`` so the EMA receives roughly
        # one sample per 200 ms regardless of chunk pacing.
        self._speed_tracker = EmaSpeedTracker()

    def run(self) -> DownloadResult:
        specs = discover_wheels()
        total_expected: int | None = None
        total_downloaded = 0
        downloaded_paths: list[Path] = []

        per_wheel_total: dict[str, int] = {}
        per_wheel_seen: dict[str, int] = {wheel.filename: 0 for wheel in specs}

        for wheel in specs:
            total_bytes = _discover_wheel_total_bytes(
                wheel,
                cancel_check=self._cancel_check,
            )
            if total_bytes is not None:
                per_wheel_total[wheel.filename] = total_bytes

        self._emit(per_wheel_seen, per_wheel_total, len(specs))

        for wheel in specs:
            def make_callback(filename: str):
                def cb(done: int, total: int | None) -> None:
                    per_wheel_seen[filename] = done
                    if total is not None:
                        per_wheel_total[filename] = total
                    self._emit(per_wheel_seen, per_wheel_total, len(specs))

                return cb

            path = download_wheel(
                wheel,
                downloads_dir(),
                on_bytes=make_callback(wheel.filename),
                cancel_check=self._cancel_check,
            )
            downloaded_paths.append(path)
            total_downloaded += path.stat().st_size

        if total_expected is None and per_wheel_total:
            total_expected = sum(per_wheel_total.values())

        return DownloadResult(
            wheels=downloaded_paths,
            bytes_downloaded=total_downloaded,
            wheel_specs=list(specs),
        )

    def _emit(
        self,
        seen: dict[str, int],
        totals: dict[str, int],
        file_count: int,
    ) -> None:
        if self._progress is None:
            return
        downloaded = sum(seen.values())
        total_sum = sum(totals.values()) if totals else 0
        total: int | None = total_sum if totals and len(totals) == file_count else None
        bytes_per_second = self._speed_tracker.update(downloaded)
        self._progress(
            {
                "stage": "download",
                "downloadedBytes": downloaded,
                "totalBytes": total,
                "totalBytesComplete": total is not None,
                "currentFile": _current_active_file(seen, totals),
                "completedFiles": sum(
                    1 for name, done in seen.items() if done and totals.get(name) and done >= totals[name]
                ),
                "totalFiles": file_count,
                "bytesPerSecond": bytes_per_second,
            }
        )


def _current_active_file(seen: dict[str, int], totals: dict[str, int]) -> str | None:
    for name, done in seen.items():
        total = totals.get(name)
        if total is None or done < total:
            return name
    return None


# ---------------------------------------------------------------------------
# Runtime metadata
# ---------------------------------------------------------------------------


def read_runtime_json() -> dict:
    path = runtime_json_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_runtime_json(update: dict) -> None:
    data = read_runtime_json()
    data.update(update)
    data["updatedAt"] = datetime.now(UTC).isoformat()
    tmp_path = runtime_json_path().with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp_path.replace(runtime_json_path())


def record_upgrade_error(message: str) -> None:
    write_runtime_json(
        {
            "lastUpgradeError": message,
            "lastUpgradeAt": datetime.now(UTC).isoformat(),
        }
    )


def record_upgrade_success(backend: str) -> None:
    write_runtime_json(
        {
            "active": backend,
            "lastKnownGoodBackend": backend,
            "lastUpgradeAt": datetime.now(UTC).isoformat(),
            "lastUpgradeError": None,
        }
    )
    if backend == "cuda":
        write_runtime_complete_marker(backend=backend)


# ---------------------------------------------------------------------------
# Install stage
# ---------------------------------------------------------------------------


# Top-level directories inside a wheel we consider "library code" and that
# must be swapped into site-packages. Everything else (``*.dist-info``,
# ``*.data``) is informational and doesn't participate in the atomic rename
# because ``pip`` isn't actually involved.
_WHEEL_LIB_DIRS = {
    "torch": ["torch", "torchgen", "functorch"],
    "torchaudio": ["torchaudio", "torio"],
}

_SELF_CHECK_SCRIPT = """
import json, sys
sys.path = [CHECK_PATH] + [item for item in sys.path if item != CHECK_PATH]
import torch
import torchaudio
import torchgen
import functorch
import torio
info = {
    'torch_version': torch.__version__,
    'torchaudio_version': torchaudio.__version__,
    'cuda_available': bool(torch.cuda.is_available()),
    'cuda_device_count': int(torch.cuda.device_count()),
}
print(json.dumps(info))
"""


def _sibling_data_dirs(wheel_root: Path, top_level: str) -> list[Path]:
    """Pick up sibling directories that ship native libraries for ``top_level``.

    pytorch wheels on Windows place extra DLLs under ``*.libs`` next to the
    package directory (``torch.libs``); we have to swap those alongside the
    main package or the imports will break.
    """

    extras: list[Path] = []
    siblings = [f"{top_level}.libs", f"{top_level}.dylibs"]
    for sibling in siblings:
        candidate = wheel_root / sibling
        if candidate.exists():
            extras.append(candidate)
    return extras


def _dist_info_dirs(wheel_root: Path, package: str) -> list[Path]:
    prefix = f"{package}-"
    entries: list[Path] = []
    for candidate in wheel_root.glob(f"{package}-*.dist-info"):
        if candidate.name.startswith(prefix):
            entries.append(candidate)
    return entries


def _extract_wheel(wheel_path: Path, destination: Path) -> Path:
    """Extract ``wheel_path`` into ``destination`` and return the extracted root."""

    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel_path) as archive:
        archive.extractall(destination)
    return destination


def _run_self_check(
    python_executable: Path,
    staging_site_packages: Path,
    timeout_seconds: int = 180,
) -> dict:
    """Import torch/torchaudio from ``staging_site_packages`` in a sub-process."""

    check_path = str(staging_site_packages)
    script = _SELF_CHECK_SCRIPT.replace("CHECK_PATH", repr(check_path))
    env = os.environ.copy()
    existing_python_path = env.get("PYTHONPATH", "")
    filtered_entries: list[str] = []
    if existing_python_path:
        for entry in existing_python_path.split(os.pathsep):
            trimmed = entry.strip()
            if not trimmed:
                continue
            try:
                if Path(trimmed).resolve() == staging_site_packages.resolve():
                    continue
            except Exception:
                pass
            filtered_entries.append(trimmed)
    env["PYTHONPATH"] = os.pathsep.join([check_path, *filtered_entries])
    result = subprocess.run(
        [str(python_executable), "-c", script],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        env=env,
    )
    if result.returncode != 0:
        raise CudaUpgradeError(
            "staging torch import failed: "
            f"rc={result.returncode} stderr={result.stderr.strip()}"
        )
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as exc:
        raise CudaUpgradeError(
            f"staging torch self-check returned unreadable output: {result.stdout!r}"
        ) from exc


def _is_retryable_replace_error(exc: BaseException) -> bool:
    if sys.platform != "win32":
        return False
    if isinstance(exc, PermissionError):
        return True
    if not isinstance(exc, OSError):
        return False
    return getattr(exc, "winerror", None) in {5, 32}


def _replace_with_retry(
    source: Path,
    destination: Path,
    *,
    attempts: int = 20,
    delay_seconds: float = 0.25,
) -> None:
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            os.replace(source, destination)
            return
        except Exception as exc:  # pragma: no cover - exercised on Windows only
            if not _is_retryable_replace_error(exc) or attempt == attempts:
                raise
            last_error = exc
            logger.warning(
                "replace busy on attempt %s/%s: %s -> %s (%s)",
                attempt,
                attempts,
                source,
                destination,
                exc,
            )
            time.sleep(delay_seconds)
    if last_error is not None:  # pragma: no cover - defensive
        raise last_error


def _copy_path_with_retry(
    source: Path,
    destination: Path,
    *,
    attempts: int = 20,
    delay_seconds: float = 0.25,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise CudaUpgradeError(f"copy target already exists: {destination}")

    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
            return
        except Exception as exc:  # pragma: no cover - exercised on Windows only
            if destination.exists():
                try:
                    if destination.is_dir():
                        shutil.rmtree(destination, ignore_errors=True)
                    else:
                        destination.unlink(missing_ok=True)
                except Exception:
                    pass
            if not _is_retryable_replace_error(exc) or attempt == attempts:
                raise
            last_error = exc
            logger.warning(
                "copy busy on attempt %s/%s: %s -> %s (%s)",
                attempt,
                attempts,
                source,
                destination,
                exc,
            )
            time.sleep(delay_seconds)
    if last_error is not None:  # pragma: no cover - defensive
        raise last_error


def _remove_path_with_retry(
    path: Path,
    *,
    attempts: int = 20,
    delay_seconds: float = 0.25,
) -> None:
    if not path.exists():
        return

    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            return
        except Exception as exc:  # pragma: no cover - exercised on Windows only
            if not _is_retryable_replace_error(exc) or attempt == attempts:
                raise
            last_error = exc
            logger.warning(
                "remove busy on attempt %s/%s: %s (%s)",
                attempt,
                attempts,
                path,
                exc,
            )
            time.sleep(delay_seconds)
    if last_error is not None:  # pragma: no cover - defensive
        raise last_error


def _safe_rename(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise CudaUpgradeError(f"rename target already exists: {destination}")
    _replace_with_retry(source, destination)


def _rollback(moves: list[tuple[Path, Path]]) -> None:
    """Undo a partial atomic swap. ``moves`` is the list of (original, backup) pairs."""

    for original, backup in reversed(moves):
        if original.exists() and not backup.exists():
            # Nothing to do — original still in place.
            continue
        if backup.exists() and not original.exists():
            try:
                _replace_with_retry(backup, original)
            except Exception as exc:  # pragma: no cover — defensive
                logger.error("failed to roll back %s -> %s: %s", backup, original, exc)
        elif backup.exists() and original.exists():
            # Remove the broken new version and restore backup.
            try:
                shutil.rmtree(original)
            except Exception:
                pass
            try:
                _replace_with_retry(backup, original)
            except Exception as exc:  # pragma: no cover
                logger.error("failed to roll back %s: %s", original, exc)


def _cleanup_old_rollbacks(keep: int = 2) -> None:
    try:
        entries = sorted(
            (path for path in rollback_root().iterdir() if path.is_dir()),
            key=lambda p: p.name,
        )
    except FileNotFoundError:
        return
    for stale in entries[:-keep]:
        shutil.rmtree(stale, ignore_errors=True)


@dataclass
class InstallResult:
    active_backend: str
    rollback_dir: Path | None
    self_check: dict


class InstallStage:
    """Extract, self-check, atomically swap, re-check (with auto-rollback)."""

    def __init__(
        self,
        downloaded_wheels: Iterable[Path],
        *,
        progress: ProgressCallback | None = None,
    ) -> None:
        self._wheels = list(downloaded_wheels)
        self._progress = progress

    def _emit(self, stage: str, message: str | None = None) -> None:
        if self._progress is None:
            return
        self._progress({"stage": stage, "message": message})

    def run(self) -> InstallResult:
        target_site_packages = current_site_packages()
        venv_python = current_venv_python()

        staging = staging_dir()
        # Start from a clean staging area.
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, exist_ok=True)
        staging_site = staging / "site-packages"
        staging_site.mkdir(parents=True, exist_ok=True)

        self._emit("verifying", "extracting wheels")
        for wheel_path in self._wheels:
            _extract_wheel(wheel_path, staging_site)

        # Sanity: the two packages we are about to swap must be present.
        for package, directories in _WHEEL_LIB_DIRS.items():
            for directory_name in directories:
                package_root = staging_site / directory_name
                if not package_root.exists():
                    raise CudaUpgradeError(
                        f"wheel extraction is missing {directory_name}/ under {staging_site}"
                    )

        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        rollback_dir = rollback_root() / timestamp
        rollback_dir.mkdir(parents=True, exist_ok=False)

        moves: list[tuple[Path, Path]] = []
        copied_targets: list[Path] = []
        try:
            # 1) Rename the existing packages out of site-packages.
            for package, directories in _WHEEL_LIB_DIRS.items():
                candidates = [target_site_packages / directory_name for directory_name in directories]
                candidates.extend(_sibling_data_dirs(target_site_packages, package))
                candidates.extend(_dist_info_dirs(target_site_packages, package))
                for candidate in candidates:
                    if not candidate.exists():
                        continue
                    backup = rollback_dir / candidate.name
                    _safe_rename(candidate, backup)
                    moves.append((candidate, backup))

            # 2) Copy the staged packages into site-packages. Using a copy here
            # avoids Windows rename failures when freshly extracted torch files
            # are still being touched by antivirus or the just-finished probe.
            for package, directories in _WHEEL_LIB_DIRS.items():
                for directory_name in directories:
                    staged = staging_site / directory_name
                    target = target_site_packages / directory_name
                    _copy_path_with_retry(staged, target)
                    copied_targets.append(target)
                for sibling in _sibling_data_dirs(staging_site, package):
                    sibling_target = target_site_packages / sibling.name
                    _copy_path_with_retry(sibling, sibling_target)
                    copied_targets.append(sibling_target)
                for dist_info in _dist_info_dirs(staging_site, package):
                    dist_target = target_site_packages / dist_info.name
                    _copy_path_with_retry(dist_info, dist_target)
                    copied_targets.append(dist_target)

            self._emit("validating", "post-swap torch.cuda self-check")
            post_check = _run_self_check(venv_python, target_site_packages)
            if not post_check.get("cuda_available"):
                raise CudaUpgradeError(
                    "post-swap torch.cuda.is_available() returned False"
                )

            record_upgrade_success("cuda")
            write_runtime_complete_marker(backend="cuda", self_check=post_check)
            _cleanup_old_rollbacks()
            self._emit("done", "cuda runtime active")
            return InstallResult(
                active_backend="cuda",
                rollback_dir=rollback_dir,
                self_check=post_check,
            )

        except Exception as exc:
            # Remove copied targets first, then restore the backed-up originals.
            for copied_target in reversed(copied_targets):
                if copied_target.exists():
                    try:
                        _remove_path_with_retry(copied_target)
                    except Exception as inner:  # pragma: no cover - defensive
                        logger.error(
                            "failed to remove copied target %s: %s",
                            copied_target,
                            inner,
                        )
            _rollback(moves)
            record_upgrade_error(str(exc))
            raise


# ---------------------------------------------------------------------------
# Self-heal / orchestrator
# ---------------------------------------------------------------------------


def torch_importable(python_executable: Path | None = None) -> bool:
    """Check whether ``import torch`` works in the target interpreter."""

    executable = python_executable or current_venv_python()
    try:
        result = subprocess.run(
            [str(executable), "-c", "import torch; import torchaudio"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as exc:
        logger.warning("unable to probe torch: %s", exc)
        return False
    return result.returncode == 0


def latest_rollback() -> Path | None:
    try:
        entries = sorted(
            (path for path in rollback_root().iterdir() if path.is_dir()),
            key=lambda p: p.name,
        )
    except FileNotFoundError:
        return None
    return entries[-1] if entries else None


def ensure_torch_healthy() -> dict:
    """Verify the current venv has a working torch and auto-restore if it does not.

    This is intended to run at sidecar start-up. If ``import torch`` fails and a
    rollback backup is available, it will swap the most recent backup back into
    ``site-packages`` and retry.
    """

    report: dict = {"action": "noop"}
    if torch_importable():
        report["action"] = "ok"
        return report

    rollback = latest_rollback()
    if rollback is None:
        report["action"] = "no_backup"
        report["message"] = "torch import failed and no rollback backup is present"
        record_upgrade_error("torch import failed; no rollback available")
        return report

    target_site_packages = current_site_packages()
    logger.warning("torch import failed; restoring backup %s", rollback)

    restored: list[tuple[Path, Path]] = []
    try:
        for item in rollback.iterdir():
            source = item
            destination = target_site_packages / item.name
            if destination.exists():
                # The install left something behind — move it aside before restoring.
                broken_target = rollback.with_name(f"broken-{rollback.name}")
                broken_target.mkdir(parents=True, exist_ok=True)
                _replace_with_retry(destination, broken_target / item.name)
            _replace_with_retry(source, destination)
            restored.append((source, destination))

        # Remove the now-empty rollback directory.
        try:
            rollback.rmdir()
        except OSError:
            pass

        if torch_importable():
            record_upgrade_success("cpu")
            report["action"] = "restored"
            return report

        record_upgrade_error("torch still fails after rollback restore")
        report["action"] = "restore_failed"
        return report

    except Exception as exc:
        logger.exception("ensure_torch_healthy failed")
        record_upgrade_error(f"self-heal failed: {exc}")
        report["action"] = "error"
        report["message"] = str(exc)
        return report


def run_cuda_upgrade(progress: ProgressCallback | None = None, cancel_check: Callable[[], bool] | None = None) -> InstallResult:
    """Top-level orchestrator combining download + install stages.

    Call this from an API route or background task. Holds the upgrade lock for
    the duration; raises :class:`UpgradeLockBusy` when another upgrade is already
    running.
    """

    with upgrade_lock():
        download_stage = DownloadStage(progress=progress, cancel_check=cancel_check)
        download_result = download_stage.run()

        install_stage = InstallStage(download_result.wheels, progress=progress)
        result = install_stage.run()

        # Delete wheels only after a successful swap; on failure we keep them so
        # the next attempt resumes at the install step.
        for wheel in download_result.wheels:
            try:
                wheel.unlink()
            except Exception:
                pass
        return result
