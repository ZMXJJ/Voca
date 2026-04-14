from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

from app.services.storage_paths import audio_output_dir


def _resolve_voxcpm_src() -> Path:
    explicit_src = os.environ.get("VOCA_VOXCPM_SRC", "").strip()
    if explicit_src:
        candidate = Path(explicit_src)
        if candidate.exists():
            return candidate

    bundle_resource_dir = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle_resource_dir:
        candidate = Path(bundle_resource_dir) / "VoxCPM" / "src"
        if candidate.exists():
            return candidate

    repo_root = Path(__file__).resolve().parents[4]
    return repo_root / "VoxCPM" / "src"


VOXCPM_SRC = _resolve_voxcpm_src()

if VOXCPM_SRC.exists() and str(VOXCPM_SRC) not in sys.path:
    sys.path.insert(0, str(VOXCPM_SRC))


class AudioEnhancer:
    def __init__(self) -> None:
        self._enhancer = None
        self._loaded_model_path: str | None = None
        self._lock = threading.Lock()

    def is_loaded(self) -> bool:
        return self._enhancer is not None

    def enhance_file(self, input_path: str, model_path: str, output_stem: str) -> str:
        input_file = Path(input_path)
        if not input_file.exists():
            raise FileNotFoundError(f"Audio file not found: {input_path}")

        output_dir = audio_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{output_stem}_enhanced.wav"
        enhancer = self._load_enhancer(model_path)
        return enhancer.enhance(str(input_file), str(output_path), normalize_loudness=True)

    def _load_enhancer(self, model_path: str):
        with self._lock:
            if self._enhancer is not None and self._loaded_model_path == model_path:
                return self._enhancer

            try:
                from voxcpm.zipenhancer import ZipEnhancer  # type: ignore
            except Exception as exc:  # pragma: no cover - runtime dependency issue
                raise RuntimeError(
                    "Failed to import ZipEnhancer runtime. "
                    "Please install the desktop runtime dependencies first."
                ) from exc

            self._enhancer = ZipEnhancer(model_path=model_path)
            self._loaded_model_path = model_path
            return self._enhancer
