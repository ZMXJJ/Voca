"""Upgrade the Voca Python runtime from CPU torch to CUDA torch in-place.

This module implements the multi-stage flow described in the Windows support
plan:

  * ``DownloadStage`` — resumable + SHA-256-verified fetch of ``torch`` and
    ``torchaudio`` wheels from the PyTorch public index.
  * ``InstallStage``  — extract the wheels into ``runtime/staging/``, run a
    sub-process import self-check, then atomically swap the old ``torch`` and
    ``torchaudio`` directories out of ``site-packages/`` (preserving them under
    ``runtime/rollback/<timestamp>/``) and move the new ones in. If the post-
    swap validation fails, the rollback is restored automatically.

All operations are idempotent and interruption-safe:

  * partially written ``*.whl.partial`` files are resumed via HTTP ``Range``.
  * corrupt downloads are detected through a whole-file SHA-256 check and
    retried up to ``MAX_DOWNLOAD_ATTEMPTS`` times.
  * the ``upgrade.lock`` file guarantees at most one concurrent upgrade.
  * on failure any fully-downloaded wheel is kept so the next attempt starts
    right at the install stage.

The Rust sidecar consumes ``runtime.json`` at boot to decide whether to
``ensure_torch_healthy`` the environment on startup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterable

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover - requests is a transitive dep of huggingface_hub
    requests = None  # type: ignore

from app.services.storage_paths import app_support_dir

logger = logging.getLogger(__name__)

PYTORCH_INDEX_BASE = "https://download.pytorch.org/whl/cu124"
TORCH_VERSION = "2.11.0"
TORCH_LOCAL_VARIANT = "cu124"
MAX_DOWNLOAD_ATTEMPTS = 3
DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024  # 4 MiB
DOWNLOAD_TIMEOUT_SECONDS = 120
REQUEST_HEADERS = {"User-Agent": "Voca-Desktop-Upgrader"}


ProgressCallback = Callable[[dict], None]


class CudaUpgradeError(RuntimeError):
    """Raised for any unrecoverable upgrade failure."""


@dataclass(frozen=True)
class WheelSpec:
    package: str  # e.g. "torch" or "torchaudio"
    filename: str
    url: str
    sha256: str | None


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


def current_venv_python() -> Path:
    """Return the interpreter running this process.

    CUDA upgrades must target the venv the sidecar is actually using; sys.executable
    is the most reliable answer here because this module only runs inside the
    sidecar process.
    """

    return Path(sys.executable)


def current_site_packages() -> Path:
    """Resolve the site-packages directory for the currently running interpreter."""

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


def _index_url(package: str) -> str:
    return f"{PYTORCH_INDEX_BASE}/{package}/"


_HREF_PATTERN = re.compile(r'href="([^"]+)"', re.IGNORECASE)


def discover_wheels() -> list[WheelSpec]:
    """Return the list of wheel specs required to move to the CUDA runtime."""

    _ensure_requests()

    python_tag = _python_tag()
    platform_tag = _platform_tag()

    wheels: list[WheelSpec] = []
    for package in ("torch", "torchaudio"):
        index_url = _index_url(package)
        logger.info("fetching pytorch index: %s", index_url)
        response = requests.get(index_url, headers=REQUEST_HEADERS, timeout=30)
        response.raise_for_status()
        wheels.append(_select_wheel(package, index_url, response.text, python_tag, platform_tag))
    return wheels


def _select_wheel(
    package: str,
    index_url: str,
    html: str,
    python_tag: str,
    platform_tag: str,
) -> WheelSpec:
    expected_version_fragment = f"-{TORCH_VERSION}+{TORCH_LOCAL_VARIANT}-"
    expected_tags = f"-{python_tag}-{python_tag}-{platform_tag}.whl"

    best: tuple[str, str, str | None] | None = None
    for match in _HREF_PATTERN.finditer(html):
        href = match.group(1)
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
            f"matching {python_tag}/{platform_tag}"
        )

    filename, url, sha256 = best
    return WheelSpec(package=package, filename=filename, url=url, sha256=sha256)


# ---------------------------------------------------------------------------
# Download stage
# ---------------------------------------------------------------------------


@dataclass
class DownloadResult:
    wheels: list[Path]
    bytes_downloaded: int
    wheel_specs: list[WheelSpec]


def _sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


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

            with requests.get(
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

            # Verify integrity.
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

    def run(self) -> DownloadResult:
        specs = discover_wheels()
        total_expected: int | None = None
        total_downloaded = 0
        downloaded_paths: list[Path] = []

        per_wheel_total: dict[str, int] = {}
        per_wheel_seen: dict[str, int] = {wheel.filename: 0 for wheel in specs}

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


# ---------------------------------------------------------------------------
# Install stage
# ---------------------------------------------------------------------------


# Top-level directories inside a wheel we consider "library code" and that
# must be swapped into site-packages. Everything else (``*.dist-info``,
# ``*.data``) is informational and doesn't participate in the atomic rename
# because ``pip`` isn't actually involved.
_WHEEL_LIB_DIRS = {
    "torch": ["torch"],
    "torchaudio": ["torchaudio"],
}

_SELF_CHECK_SCRIPT = """
import json, sys
sys.path.insert(0, STAGING_PATH)
import torch
import torchaudio
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

    script = _SELF_CHECK_SCRIPT.replace(
        "STAGING_PATH", repr(str(staging_site_packages))
    )
    result = subprocess.run(
        [str(python_executable), "-c", script],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
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


def _safe_rename(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise CudaUpgradeError(f"rename target already exists: {destination}")
    os.replace(source, destination)


def _rollback(moves: list[tuple[Path, Path]]) -> None:
    """Undo a partial atomic swap. ``moves`` is the list of (original, backup) pairs."""

    for original, backup in reversed(moves):
        if original.exists() and not backup.exists():
            # Nothing to do — original still in place.
            continue
        if backup.exists() and not original.exists():
            try:
                os.replace(backup, original)
            except Exception as exc:  # pragma: no cover — defensive
                logger.error("failed to roll back %s -> %s: %s", backup, original, exc)
        elif backup.exists() and original.exists():
            # Remove the broken new version and restore backup.
            try:
                shutil.rmtree(original)
            except Exception:
                pass
            try:
                os.replace(backup, original)
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
        for package in _WHEEL_LIB_DIRS:
            package_root = staging_site / package
            if not package_root.exists():
                raise CudaUpgradeError(
                    f"wheel extraction is missing {package}/ under {staging_site}"
                )

        self._emit("installing", "pre-swap self-check")
        pre_check = _run_self_check(venv_python, staging_site)
        if not pre_check.get("cuda_available"):
            raise CudaUpgradeError(
                "pre-swap torch.cuda.is_available() returned False; aborting"
            )

        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        rollback_dir = rollback_root() / timestamp
        rollback_dir.mkdir(parents=True, exist_ok=False)

        moves: list[tuple[Path, Path]] = []
        staged_moves: list[tuple[Path, Path]] = []
        try:
            # 1) Rename the existing packages out of site-packages.
            for package, _directories in _WHEEL_LIB_DIRS.items():
                for candidate in [target_site_packages / package] + _sibling_data_dirs(
                    target_site_packages, package
                ):
                    if not candidate.exists():
                        continue
                    backup = rollback_dir / candidate.name
                    _safe_rename(candidate, backup)
                    moves.append((candidate, backup))

            # 2) Move the staged packages into site-packages.
            for package, _directories in _WHEEL_LIB_DIRS.items():
                staged = staging_site / package
                target = target_site_packages / package
                _safe_rename(staged, target)
                staged_moves.append((staged, target))
                for sibling in _sibling_data_dirs(staging_site, package):
                    sibling_target = target_site_packages / sibling.name
                    _safe_rename(sibling, sibling_target)
                    staged_moves.append((sibling, sibling_target))

            self._emit("validating", "post-swap torch.cuda self-check")
            post_check = _run_self_check(venv_python, target_site_packages)
            if not post_check.get("cuda_available"):
                raise CudaUpgradeError(
                    "post-swap torch.cuda.is_available() returned False"
                )

            record_upgrade_success("cuda")
            _cleanup_old_rollbacks()
            self._emit("done", "cuda runtime active")
            return InstallResult(
                active_backend="cuda",
                rollback_dir=rollback_dir,
                self_check=post_check,
            )

        except Exception as exc:
            # Undo new-package moves first, then restore the backed-up originals.
            for staged_source, staged_target in reversed(staged_moves):
                if staged_target.exists():
                    try:
                        staged_source.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(staged_target, staged_source)
                    except Exception as inner:  # pragma: no cover - defensive
                        logger.error(
                            "failed to undo staged move %s -> %s: %s",
                            staged_target,
                            staged_source,
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
                os.replace(destination, broken_target / item.name)
            os.replace(source, destination)
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
