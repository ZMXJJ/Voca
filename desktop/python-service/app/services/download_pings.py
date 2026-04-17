"""Best-effort startup pings to contribute download counts for the TTS models.

Each time the Python sidecar boots we fire a single request per TTS model to the
currently recommended provider (Hugging Face or ModelScope) using the official
SDKs. When the local copy is already present these calls hit the provider's
cache path and transfer ~0 bytes while still incrementing the public download
counter used for community visibility.

All failures are swallowed silently: this code path must never affect the
service startup or runtime behaviour.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from app.models.schemas import ModelCatalogEntry
from app.services.bootstrap_assets import is_asset_ready, list_tts_entries
from app.services.provider_router import recommend_provider
from app.services.storage_paths import huggingface_hub_cache_dir

logger = logging.getLogger(__name__)

_PING_FILENAME = "config.json"
_THREAD_NAME = "voca-download-pings"


def _is_disabled() -> bool:
    return os.environ.get("VOCA_DISABLE_DOWNLOAD_PING", "").strip() == "1"


def _select_provider_order(recommended: str) -> tuple[str, ...]:
    if recommended == "modelscope":
        return ("modelscope", "huggingface")
    if recommended == "huggingface":
        return ("huggingface", "modelscope")
    return ("huggingface", "modelscope")


def ping_huggingface(repo_id: str) -> bool:
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
    except Exception:
        logger.debug("huggingface_hub not available, skip HF ping for %s", repo_id)
        return False

    cache_dir = huggingface_hub_cache_dir()
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        hf_hub_download(
            repo_id=repo_id,
            filename=_PING_FILENAME,
            cache_dir=str(cache_dir),
            force_download=True,
        )
        logger.debug("HF ping ok: %s", repo_id)
        return True
    except Exception as exc:  # pragma: no cover - best-effort
        logger.debug("HF ping failed for %s: %s", repo_id, exc)
        return False


def ping_modelscope(model_id: str, local_dir: Path) -> bool:
    try:
        from modelscope.hub.snapshot_download import snapshot_download  # type: ignore
    except Exception:
        logger.debug("modelscope not available, skip MS ping for %s", model_id)
        return False

    try:
        snapshot_download(model_id, local_dir=str(local_dir))
        logger.debug("ModelScope ping ok: %s", model_id)
        return True
    except Exception as exc:  # pragma: no cover - best-effort
        logger.debug("ModelScope ping failed for %s: %s", model_id, exc)
        return False


def _ping_entry(entry: ModelCatalogEntry, recommended: str) -> bool:
    for provider in _select_provider_order(recommended):
        provider_info = entry.providers.get(provider)
        if provider_info is None:
            continue

        if provider == "huggingface":
            repo_id = getattr(provider_info, "repoId", None)
            if not repo_id:
                continue
            if ping_huggingface(repo_id):
                return True
            continue

        if provider == "modelscope":
            model_id = getattr(provider_info, "modelId", None)
            if not model_id:
                continue
            if ping_modelscope(model_id, Path(entry.localDir)):
                return True
            continue

    return False


def dispatch_startup_pings() -> None:
    if _is_disabled():
        logger.debug("download pings disabled via VOCA_DISABLE_DOWNLOAD_PING")
        return

    try:
        recommendation = recommend_provider("auto")
        recommended = recommendation.recommended or "huggingface"
    except Exception as exc:
        logger.debug("provider recommendation failed, fallback to huggingface: %s", exc)
        recommended = "huggingface"

    try:
        entries = list_tts_entries()
    except Exception as exc:
        logger.debug("cannot list TTS entries for download pings: %s", exc)
        return

    for entry in entries:
        try:
            if not is_asset_ready(entry):
                logger.debug(
                    "skip download ping for %s: local asset not ready",
                    entry.modelKey,
                )
                continue
            _ping_entry(entry, recommended)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "download ping dispatch failed for %s: %s", entry.modelKey, exc
            )


def start_download_ping_dispatcher() -> None:
    if _is_disabled():
        return
    thread = threading.Thread(
        target=dispatch_startup_pings,
        name=_THREAD_NAME,
        daemon=True,
    )
    thread.start()
