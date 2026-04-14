from __future__ import annotations

import json
import shutil
from pathlib import Path

from app.models.schemas import ModelCatalogEntry, ProviderInfo
from app.services.storage_paths import app_support_dir, models_dir, runtime_model_catalog_path

_LEGACY_MODEL_KEY_MAP = {
    "voxcpm2-default": "voxcpm2",
    "voxcpm1.5-default": "voxcpm1_5",
    "voxcpm1.5": "voxcpm1_5",
    "voxcpm-0.5b-default": "voxcpm_05b",
}

_LEGACY_LOCAL_DIR_MAP = {
    "voxcpm2": "voxcpm2-default",
    "voxcpm1_5": "voxcpm1.5-default",
    "voxcpm_05b": "voxcpm-0.5b-default",
}
def default_model_catalog_path() -> Path:
    return Path(__file__).resolve().parents[1] / "config" / "model_catalog.json"


def _seed_runtime_model_catalog() -> None:
    runtime_path = runtime_model_catalog_path()
    if runtime_path.exists():
        return

    default_path = default_model_catalog_path()
    if not default_path.exists():
        raise FileNotFoundError(f"Default model catalog not found: {default_path}")

    app_support_dir().mkdir(parents=True, exist_ok=True)
    shutil.copy2(default_path, runtime_path)


def _model_key_for_merge(model: dict) -> str:
    return _normalize_model_key(str(model.get("modelKey", "")))


def _merge_catalog_payload(default_payload: dict, runtime_payload: dict) -> dict:
    default_models = default_payload.get("models") or []
    runtime_models = runtime_payload.get("models") or []

    runtime_by_key = {
        _model_key_for_merge(model): model
        for model in runtime_models
        if isinstance(model, dict)
    }
    merged_models: list[dict] = []
    seen_keys: set[str] = set()

    for model in default_models:
        if not isinstance(model, dict):
            continue
        model_key = _model_key_for_merge(model)
        runtime_model = runtime_by_key.get(model_key, {})
        # Default catalog wins for known fields so new bundled metadata always lands.
        merged_models.append({**runtime_model, **model})
        seen_keys.add(model_key)

    for model in runtime_models:
        if not isinstance(model, dict):
            continue
        model_key = _model_key_for_merge(model)
        if model_key in seen_keys:
            continue
        merged_models.append(dict(model))

    return {
        **runtime_payload,
        **default_payload,
        "models": merged_models,
    }


def _load_catalog_payload() -> dict:
    _seed_runtime_model_catalog()
    runtime_path = runtime_model_catalog_path()
    default_path = default_model_catalog_path()

    default_payload = json.loads(default_path.read_text(encoding="utf-8"))
    runtime_payload = (
        json.loads(runtime_path.read_text(encoding="utf-8"))
        if runtime_path.exists()
        else default_payload
    )
    merged_payload = _merge_catalog_payload(default_payload, runtime_payload)
    normalized = _normalize_catalog_payload(merged_payload)

    if not runtime_path.exists() or normalized != runtime_payload:
        runtime_path.write_text(
            json.dumps(normalized, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    return normalized


def _normalize_model_key(model_key: str) -> str:
    return _LEGACY_MODEL_KEY_MAP.get(model_key, model_key)


def _normalize_local_dir_name(local_dir_name: str) -> str:
    return _normalize_model_key(local_dir_name)


def _resolve_local_dir_name(local_dir_name: str, model_key: str) -> str:
    canonical_dir_name = _normalize_local_dir_name(local_dir_name)
    canonical_dir = models_dir() / canonical_dir_name
    if canonical_dir.exists():
        return canonical_dir_name

    legacy_dir_name = _LEGACY_LOCAL_DIR_MAP.get(model_key)
    if legacy_dir_name and (models_dir() / legacy_dir_name).exists():
        return legacy_dir_name

    return canonical_dir_name


def _normalize_catalog_payload(payload: dict) -> dict:
    models = payload.get("models") or []
    normalized_models: list[dict] = []
    for model in models:
        if not isinstance(model, dict):
            continue
        normalized_model = dict(model)
        normalized_model_key = _normalize_model_key(str(model.get("modelKey", "")))
        normalized_model["modelKey"] = normalized_model_key
        normalized_model["localDirName"] = _normalize_local_dir_name(
            str(model.get("localDirName") or normalized_model_key)
        )
        normalized_models.append(normalized_model)
    return {
        **payload,
        "models": normalized_models,
    }


def _build_model_entry(raw_entry: dict) -> ModelCatalogEntry:
    normalized_model_key = _normalize_model_key(str(raw_entry["modelKey"]))
    local_dir_name = _resolve_local_dir_name(
        str(raw_entry.get("localDirName") or normalized_model_key),
        normalized_model_key,
    )
    providers = {
        provider_name: ProviderInfo(**provider_value)
        for provider_name, provider_value in (raw_entry.get("providers") or {}).items()
    }
    return ModelCatalogEntry(
        modelKey=normalized_model_key,
        displayName=str(raw_entry["displayName"]),
        defaultProvider=str(raw_entry["defaultProvider"]),
        localDir=str(models_dir() / local_dir_name),
        assetRole=str(raw_entry.get("assetRole") or "tts"),
        bootstrapRequired=bool(raw_entry.get("bootstrapRequired", False)),
        approxSizeLabel=raw_entry.get("approxSizeLabel"),
        providers=providers,
    )


def load_model_catalog() -> dict[str, ModelCatalogEntry]:
    payload = _load_catalog_payload()
    entries = payload.get("models") or []
    catalog: dict[str, ModelCatalogEntry] = {}
    for entry in entries:
        model_entry = _build_model_entry(entry)
        catalog[model_entry.modelKey] = model_entry
    return catalog


def get_model_entry(model_key: str) -> ModelCatalogEntry:
    model_catalog = load_model_catalog()
    normalized_model_key = _normalize_model_key(model_key)
    try:
        return model_catalog[normalized_model_key]
    except KeyError as exc:  # pragma: no cover - straightforward lookup
        raise ValueError(f"Unsupported model key: {model_key}") from exc


def list_model_entries() -> list[ModelCatalogEntry]:
    return list(load_model_catalog().values())
