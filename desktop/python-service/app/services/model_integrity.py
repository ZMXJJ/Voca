"""Model asset integrity helpers.

Provides a per-model manifest (`.voca-manifest.json`) that records size + SHA256
for each file in a downloaded model directory, plus staging/promotion primitives
so downloads only become visible after passing an integrity check.

Layout under ``models_dir()``::

    models/
    ├── voxcpm2/                       # Final, user-visible asset dir
    │   ├── config.json
    │   ├── model.safetensors
    │   ├── ...
    │   └── .voca-manifest.json        # Written after a successful download
    ├── .staging/                      # Work-in-progress downloads
    │   └── voxcpm2/...
    └── .trash/                        # Quarantined old dirs awaiting rmtree
        └── voxcpm2-1776393600/...
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

from app.services.storage_paths import models_dir

_logger = logging.getLogger(__name__)

MANIFEST_FILENAME = ".voca-manifest.json"
MANIFEST_VERSION = 1
STAGING_DIR_NAME = ".staging"
TRASH_DIR_NAME = ".trash"

# Files we always hash in full on startup. Small (~KB) so cost is negligible.
CRITICAL_FILES: frozenset[str] = frozenset(
    {
        "config.json",
        "configuration.json",
        "tokenizer.json",
        "tokenizer_config.json",
    }
)

# Top-level directory/file prefixes to skip from manifest (tool caches etc.).
_SKIP_TOP_LEVEL_PREFIXES: tuple[str, ...] = (".",)

# Age thresholds for cleanup of orphaned staging/trash entries.
TRASH_MAX_AGE_SECONDS = 24 * 60 * 60
STAGING_MAX_AGE_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    reason: str | None = None

    @classmethod
    def success(cls) -> "VerifyResult":
        return cls(True, None)

    @classmethod
    def failure(cls, reason: str) -> "VerifyResult":
        return cls(False, reason)


def models_root_dir() -> Path:
    """Return the top-level models directory (may not exist yet)."""
    return models_dir()


def staging_root() -> Path:
    return models_root_dir() / STAGING_DIR_NAME


def trash_root() -> Path:
    return models_root_dir() / TRASH_DIR_NAME


def stage_dir(model_key: str) -> Path:
    """Return the staging directory for a given model key."""
    return staging_root() / model_key


def manifest_path(local_dir: Path) -> Path:
    return local_dir / MANIFEST_FILENAME


def _iter_manifest_files(local_dir: Path) -> Iterable[Path]:
    """Yield files that should be recorded in the manifest.

    Skips:
      * Top-level entries whose name starts with ``.`` (tool caches).
      * The manifest file itself.
    """
    if not local_dir.is_dir():
        return

    for top_entry in sorted(local_dir.iterdir()):
        name = top_entry.name
        if name == MANIFEST_FILENAME:
            continue
        if any(name.startswith(prefix) for prefix in _SKIP_TOP_LEVEL_PREFIXES):
            continue

        if top_entry.is_file():
            yield top_entry
            continue

        if top_entry.is_dir():
            for sub_path in sorted(top_entry.rglob("*")):
                if sub_path.is_file():
                    yield sub_path


def _hash_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def compute_manifest(
    local_dir: Path, *, model_key: str, provider: str | None = None
) -> dict:
    """Compute a complete manifest by hashing every eligible file."""
    files_payload: list[dict] = []
    for file_path in _iter_manifest_files(local_dir):
        relative = file_path.relative_to(local_dir).as_posix()
        size = file_path.stat().st_size
        sha256 = _hash_file(file_path)
        files_payload.append({"path": relative, "size": size, "sha256": sha256})

    return {
        "version": MANIFEST_VERSION,
        "modelKey": model_key,
        "provider": provider,
        "completedAt": datetime.now(UTC).isoformat(),
        "files": files_payload,
    }


def write_manifest(local_dir: Path, payload: dict) -> None:
    """Atomically write the manifest file into ``local_dir``."""
    local_dir.mkdir(parents=True, exist_ok=True)
    target = manifest_path(local_dir)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)


def load_manifest(local_dir: Path) -> dict | None:
    path = manifest_path(local_dir)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _logger.warning("Failed to parse manifest at %s: %s", path, exc)
        return None

    if not isinstance(payload, dict):
        return None
    if payload.get("version") != MANIFEST_VERSION:
        _logger.info(
            "Manifest version mismatch at %s (got %r, expected %r)",
            path,
            payload.get("version"),
            MANIFEST_VERSION,
        )
        return None
    files = payload.get("files")
    if not isinstance(files, list):
        return None
    return payload


def _verify_files(
    local_dir: Path,
    manifest: dict,
    *,
    hash_all: bool,
) -> VerifyResult:
    files = manifest.get("files") or []
    if not files:
        return VerifyResult.failure("manifest contains no files")

    for entry in files:
        if not isinstance(entry, dict):
            return VerifyResult.failure("invalid manifest entry")

        rel_path = entry.get("path")
        expected_size = entry.get("size")
        expected_sha = entry.get("sha256")
        if not isinstance(rel_path, str) or not isinstance(expected_size, int):
            return VerifyResult.failure("invalid manifest entry fields")

        target = local_dir / rel_path
        if not target.exists() or not target.is_file():
            return VerifyResult.failure(f"missing file: {rel_path}")

        try:
            actual_size = target.stat().st_size
        except OSError as exc:
            return VerifyResult.failure(f"cannot stat {rel_path}: {exc}")
        if actual_size != expected_size:
            return VerifyResult.failure(
                f"size mismatch for {rel_path}: expected {expected_size}, got {actual_size}"
            )

        needs_hash = hash_all or Path(rel_path).name in CRITICAL_FILES
        if needs_hash and isinstance(expected_sha, str):
            actual_sha = _hash_file(target)
            if actual_sha != expected_sha:
                return VerifyResult.failure(
                    f"sha256 mismatch for {rel_path}: expected {expected_sha}, got {actual_sha}"
                )

    return VerifyResult.success()


def verify_quick(local_dir: Path) -> VerifyResult:
    """Fast integrity check: existence + size for all files; SHA256 only for critical ones."""
    manifest = load_manifest(local_dir)
    if manifest is None:
        return VerifyResult.failure("manifest missing")
    return _verify_files(local_dir, manifest, hash_all=False)


def verify_full(local_dir: Path) -> VerifyResult:
    """Exhaustive integrity check: SHA256 for every file recorded in the manifest."""
    manifest = load_manifest(local_dir)
    if manifest is None:
        return VerifyResult.failure("manifest missing")
    return _verify_files(local_dir, manifest, hash_all=True)


def promote_staging_to_final(staging: Path, final: Path) -> None:
    """Atomically swap ``staging`` into ``final``, quarantining any existing final dir.

    Both paths are expected to live on the same filesystem (``models/`` root).
    Any pre-existing final directory is renamed into ``models/.trash/<name>-<ts>``
    and then removed in a background thread.
    """
    if not staging.exists() or not staging.is_dir():
        raise FileNotFoundError(f"Staging directory not found: {staging}")

    final.parent.mkdir(parents=True, exist_ok=True)
    trash_root_path = trash_root()
    trash_root_path.mkdir(parents=True, exist_ok=True)

    quarantined: Path | None = None
    if final.exists():
        timestamp = int(time.time())
        quarantined = trash_root_path / f"{final.name}-{timestamp}"
        # Guard against a vanishingly unlikely clash.
        counter = 0
        while quarantined.exists():
            counter += 1
            quarantined = trash_root_path / f"{final.name}-{timestamp}-{counter}"
        os.rename(final, quarantined)

    try:
        os.rename(staging, final)
    except OSError:
        # Roll back so caller can retry; leave staging in place.
        if quarantined is not None and not final.exists():
            try:
                os.rename(quarantined, final)
            except OSError as rollback_exc:
                _logger.error(
                    "Failed to roll back quarantined directory %s: %s",
                    quarantined,
                    rollback_exc,
                )
        raise

    if quarantined is not None:
        _schedule_rmtree(quarantined)


def _schedule_rmtree(path: Path) -> None:
    def _run() -> None:
        try:
            shutil.rmtree(path, ignore_errors=True)
        except Exception as exc:  # pragma: no cover - defensive
            _logger.warning("Background rmtree failed for %s: %s", path, exc)

    thread = threading.Thread(target=_run, name=f"voca-trash-cleanup", daemon=True)
    thread.start()


def cleanup_orphans(
    *,
    trash_max_age_seconds: int = TRASH_MAX_AGE_SECONDS,
    staging_max_age_seconds: int = STAGING_MAX_AGE_SECONDS,
) -> None:
    """Best-effort cleanup of abandoned staging/trash directories."""
    now = time.time()

    for root, max_age in (
        (trash_root(), trash_max_age_seconds),
        (staging_root(), staging_max_age_seconds),
    ):
        if not root.exists():
            continue
        try:
            entries = list(root.iterdir())
        except OSError as exc:
            _logger.debug("Cannot list %s for cleanup: %s", root, exc)
            continue

        for entry in entries:
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if now - mtime < max_age:
                continue
            try:
                if entry.is_file():
                    entry.unlink(missing_ok=True)
                else:
                    shutil.rmtree(entry, ignore_errors=True)
                _logger.info("Cleaned up orphan directory: %s", entry)
            except Exception as exc:  # pragma: no cover - defensive
                _logger.warning("Failed to clean up %s: %s", entry, exc)
