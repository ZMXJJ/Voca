from __future__ import annotations

from pathlib import Path

from app.models.schemas import BootstrapAssetStatus, ModelCatalogEntry
from app.services.model_catalog import get_model_entry, list_model_entries

BOOTSTRAP_MODEL_KEYS: tuple[str, ...] = ("voxcpm2", "sensevoice_small", "zipenhancer_16k")


def bootstrap_entries() -> list[ModelCatalogEntry]:
    return [get_model_entry(model_key) for model_key in BOOTSTRAP_MODEL_KEYS]


def is_asset_ready(entry: ModelCatalogEntry) -> bool:
    local_dir = Path(entry.localDir)
    if not local_dir.exists():
        return False

    if entry.assetRole == "tts":
        return (local_dir / "config.json").exists()

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
        statuses.append(
            BootstrapAssetStatus(
                modelKey=entry.modelKey,
                displayName=entry.displayName,
                assetRole=entry.assetRole,
                ready=is_asset_ready(entry),
                bootstrapRequired=entry.bootstrapRequired,
                localDir=entry.localDir,
                approxSizeLabel=entry.approxSizeLabel,
            )
        )
    return statuses


def all_bootstrap_assets_ready() -> bool:
    statuses = bootstrap_asset_statuses()
    return bool(statuses) and all(item.ready for item in statuses)


def list_tts_entries() -> list[ModelCatalogEntry]:
    return [entry for entry in list_model_entries() if entry.assetRole == "tts"]
