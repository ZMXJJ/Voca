from __future__ import annotations

import os
from pathlib import Path

from app.models.schemas import BootstrapAssetStatus, ModelCatalogEntry
from app.services.model_catalog import get_model_entry, list_model_entries
from app.services.model_integrity import load_manifest, verify_quick

BOOTSTRAP_MODEL_KEYS: tuple[str, ...] = ("voxcpm2", "sensevoice_small", "zipenhancer_16k")
_VOXCPM_REQUIRED_FILES: tuple[str, ...] = ("config.json", "tokenizer.json", "tokenizer_config.json")
_VOXCPM_AUDIO_VAE_FILES: tuple[str, ...] = ("audiovae.safetensors", "audiovae.pth")
_VOXCPM_MODEL_WEIGHT_FILES: tuple[str, ...] = ("model.safetensors", "pytorch_model.bin", "model.bin")


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


def is_asset_ready(entry: ModelCatalogEntry) -> bool:
    local_dir = _resolve_asset_dir(entry)
    if not local_dir.exists():
        return False

    if load_manifest(local_dir) is not None:
        return verify_quick(local_dir).ok

    if entry.assetRole == "tts":
        return _is_voxcpm_ready(local_dir)

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
