from __future__ import annotations

from pathlib import Path

from app.models.schemas import ModelCatalogEntry, ProviderInfo


def app_support_dir() -> Path:
    return Path.home() / "Library" / "Application Support" / "Voca"


def models_dir() -> Path:
    return app_support_dir() / "models"


MODEL_CATALOG: dict[str, ModelCatalogEntry] = {
    "voxcpm2-default": ModelCatalogEntry(
        modelKey="voxcpm2-default",
        displayName="VoxCPM2",
        defaultProvider="huggingface",
        localDir=str(models_dir() / "voxcpm2-default"),
        providers={
            "huggingface": ProviderInfo(repoId="openbmb/VoxCPM2"),
            "modelscope": ProviderInfo(modelId="OpenBMB/VoxCPM2"),
        },
    ),
    "voxcpm1.5-default": ModelCatalogEntry(
        modelKey="voxcpm1.5-default",
        displayName="VoxCPM1.5",
        defaultProvider="huggingface",
        localDir=str(models_dir() / "voxcpm1.5-default"),
        providers={
            "huggingface": ProviderInfo(repoId="openbmb/VoxCPM1.5"),
            "modelscope": ProviderInfo(modelId="OpenBMB/VoxCPM1.5"),
        },
    ),
    "voxcpm-0.5b-default": ModelCatalogEntry(
        modelKey="voxcpm-0.5b-default",
        displayName="VoxCPM-0.5B",
        defaultProvider="huggingface",
        localDir=str(models_dir() / "voxcpm-0.5b-default"),
        providers={
            "huggingface": ProviderInfo(repoId="openbmb/VoxCPM-0.5B"),
            "modelscope": ProviderInfo(modelId="OpenBMB/VoxCPM-0.5B"),
        },
    ),
}


def get_model_entry(model_key: str) -> ModelCatalogEntry:
    try:
        return MODEL_CATALOG[model_key]
    except KeyError as exc:  # pragma: no cover - straightforward lookup
        raise ValueError(f"Unsupported model key: {model_key}") from exc


def list_model_entries() -> list[ModelCatalogEntry]:
    return list(MODEL_CATALOG.values())
