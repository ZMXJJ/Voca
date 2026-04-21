from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from app.models.schemas import BootstrapAssetStatus, ModelCatalogEntry
from app.services.model_catalog import get_model_entry, list_model_entries
from app.services.model_integrity import (
    _schedule_rmtree,  # type: ignore[attr-defined]  # reused intentionally
    load_manifest,
    trash_root,
    verify_quick,
)
from app.services.storage_paths import models_dir

logger = logging.getLogger(__name__)

BOOTSTRAP_MODEL_KEYS: tuple[str, ...] = ("voxcpm2", "sensevoice_small", "zipenhancer_16k")
_VOXCPM_REQUIRED_FILES: tuple[str, ...] = ("config.json", "tokenizer.json", "tokenizer_config.json")
_VOXCPM_AUDIO_VAE_FILES: tuple[str, ...] = ("audiovae.safetensors", "audiovae.pth")
_VOXCPM_MODEL_WEIGHT_FILES: tuple[str, ...] = ("model.safetensors", "pytorch_model.bin", "model.bin")
_SENSEVOICE_ONNX_REQUIRED_FILES: tuple[str, ...] = ("am.mvn", "tokens.json")
_SENSEVOICE_ONNX_WEIGHT_FILES: tuple[str, ...] = ("model_quant.onnx", "model.onnx")

# Pre-ONNX FunASR / PyTorch SenseVoice lived under ``models/sensevoice_small/``
# with ``model.pt`` as the signature file (~936 MB). Starting with the ONNX
# migration the new model is installed to ``models/sensevoice_small_onnx/``.
# The legacy directory becomes dead weight we actively clean up on upgrade.
_LEGACY_SENSEVOICE_PT_DIR_NAME: str = "sensevoice_small"
_LEGACY_SENSEVOICE_PT_SIGNATURE_FILES: tuple[str, ...] = ("model.pt",)


def bootstrap_entries() -> list[ModelCatalogEntry]:
    return [get_model_entry(model_key) for model_key in BOOTSTRAP_MODEL_KEYS]


def _resolve_asset_dir(entry: ModelCatalogEntry) -> Path:
    if entry.assetRole == "tts":
        override_path = os.environ.get("VOXCPM_MODEL_DIR", "").strip()
        if override_path:
            candidate = Path(override_path).expanduser()
            if candidate.is_dir():
                return candidate
    return Path(entry.localDir)


def _has_any_file(local_dir: Path, candidates: tuple[str, ...]) -> bool:
    return any((local_dir / candidate).exists() for candidate in candidates)


def _is_voxcpm_ready(local_dir: Path) -> bool:
    if not all((local_dir / required_file).exists() for required_file in _VOXCPM_REQUIRED_FILES):
        return False
    if not _has_any_file(local_dir, _VOXCPM_AUDIO_VAE_FILES):
        return False
    if not _has_any_file(local_dir, _VOXCPM_MODEL_WEIGHT_FILES):
        return False
    return True


def _is_sensevoice_onnx_ready(local_dir: Path) -> bool:
    if not all(
        (local_dir / required_file).exists()
        for required_file in _SENSEVOICE_ONNX_REQUIRED_FILES
    ):
        return False
    return _has_any_file(local_dir, _SENSEVOICE_ONNX_WEIGHT_FILES)


def is_asset_ready(entry: ModelCatalogEntry) -> bool:
    local_dir = _resolve_asset_dir(entry)
    if not local_dir.exists():
        return False

    if load_manifest(local_dir) is not None:
        return verify_quick(local_dir).ok

    if entry.assetRole == "tts":
        return _is_voxcpm_ready(local_dir)

    if entry.assetRole == "asr":
        return _is_sensevoice_onnx_ready(local_dir)

    for candidate in (
        "config.json",
        "configuration.json",
        "model.pt",
        "model.bin",
        "model.safetensors",
    ):
        if (local_dir / candidate).exists():
            return True

    return any(path.is_file() for path in local_dir.rglob("*"))


def bootstrap_asset_statuses() -> list[BootstrapAssetStatus]:
    statuses: list[BootstrapAssetStatus] = []
    for entry in bootstrap_entries():
        local_dir = _resolve_asset_dir(entry)
        statuses.append(
            BootstrapAssetStatus(
                modelKey=entry.modelKey,
                displayName=entry.displayName,
                assetRole=entry.assetRole,
                ready=is_asset_ready(entry),
                bootstrapRequired=entry.bootstrapRequired,
                localDir=str(local_dir),
                approxSizeLabel=entry.approxSizeLabel,
            )
        )
    return statuses


def all_bootstrap_assets_ready() -> bool:
    statuses = bootstrap_asset_statuses()
    return bool(statuses) and all(item.ready for item in statuses)


def list_tts_entries() -> list[ModelCatalogEntry]:
    return [entry for entry in list_model_entries() if entry.assetRole == "tts"]


def _legacy_sensevoice_pt_dir() -> Path:
    return models_dir() / _LEGACY_SENSEVOICE_PT_DIR_NAME


def has_legacy_sensevoice_pytorch() -> bool:
    """Detect the pre-ONNX FunASR SenseVoice directory that must be removed on upgrade.

    The new ONNX backend installs to ``sensevoice_small_onnx/``. Any on-disk
    ``sensevoice_small/model.pt`` from an older Voca release is stale and
    cannot be loaded by the new runtime — we surface this to the UI so the
    user can confirm deletion before the new model is downloaded.
    """
    legacy_dir = _legacy_sensevoice_pt_dir()
    if not legacy_dir.is_dir():
        return False
    return any(
        (legacy_dir / filename).exists()
        for filename in _LEGACY_SENSEVOICE_PT_SIGNATURE_FILES
    )


def cleanup_legacy_sensevoice_pytorch() -> bool:
    """Move the legacy PyTorch SenseVoice directory into ``.trash/`` for async rmtree.

    Returns True when a legacy directory was found and relocated, False when
    nothing matched (already clean, or never installed). The actual disk
    reclaim happens in a background thread via
    :func:`model_integrity._schedule_rmtree`, matching how regular model
    redownloads swap out existing directories.
    """
    if not has_legacy_sensevoice_pytorch():
        return False

    legacy_dir = _legacy_sensevoice_pt_dir()
    trash_root_path = trash_root()
    trash_root_path.mkdir(parents=True, exist_ok=True)

    timestamp = int(time.time())
    destination = trash_root_path / f"{legacy_dir.name}-legacy-{timestamp}"
    counter = 0
    while destination.exists():
        counter += 1
        destination = trash_root_path / f"{legacy_dir.name}-legacy-{timestamp}-{counter}"

    os.rename(legacy_dir, destination)
    logger.info(
        "Quarantined legacy SenseVoice PyTorch assets: %s -> %s",
        legacy_dir,
        destination,
    )
    _schedule_rmtree(destination)
    return True
