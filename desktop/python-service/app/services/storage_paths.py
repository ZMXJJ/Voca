from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def _platform_app_support_root() -> Path:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support"
    return home / ".local" / "share"


def _expand_env_path(name: str) -> Path | None:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return None
    return Path(raw_value).expanduser()


def app_support_dir() -> Path:
    return _expand_env_path("VOCA_APP_SUPPORT_DIR") or (_platform_app_support_root() / "Voca")


def models_dir() -> Path:
    override = _expand_env_path("VOCA_MODEL_DIR") or _expand_env_path("VOXCPM_MODEL_DIR")
    return override or (app_support_dir() / "models")


def runtime_model_catalog_path() -> Path:
    return app_support_dir() / "model_catalog.json"


def logs_dir() -> Path:
    return app_support_dir() / "logs"


def voices_dir() -> Path:
    return app_support_dir() / "voices"


def database_path() -> Path:
    return app_support_dir() / "voca.db"


def huggingface_home_dir() -> Path:
    return _expand_env_path("HF_HOME") or (app_support_dir() / "huggingface")


def huggingface_hub_cache_dir() -> Path:
    return _expand_env_path("HF_HUB_CACHE") or (huggingface_home_dir() / "hub")


def modelscope_cache_dir() -> Path:
    return _expand_env_path("MODELSCOPE_CACHE") or (app_support_dir() / "modelscope")


def torch_cache_dir() -> Path:
    return _expand_env_path("TORCH_HOME") or (app_support_dir() / "torch")


def audio_output_dir() -> Path:
    return Path(tempfile.gettempdir()) / "voca" / "outputs"
