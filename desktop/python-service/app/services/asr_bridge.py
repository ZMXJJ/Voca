from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any


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


class ASRBridge:
    def __init__(self) -> None:
        self._model: Any | None = None
        self._loaded_model_path: str | None = None
        self._lock = threading.Lock()

    def is_model_loaded(self) -> bool:
        return self._model is not None

    def transcribe(self, audio_path: str, model_path: str) -> tuple[str, str | None]:
        audio_file = Path(audio_path)
        if not audio_file.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        model = self._load_model(model_path)
        result = model.generate(input=str(audio_file), language="auto", use_itn=True)
        transcript = self._extract_text(result)
        if not transcript:
            raise RuntimeError("SenseVoice returned an empty transcript")
        return transcript, "auto"

    def _load_model(self, model_path: str):
        with self._lock:
            if self._model is not None and self._loaded_model_path == model_path:
                return self._model

            try:
                import torch  # type: ignore
                from funasr import AutoModel  # type: ignore
            except Exception as exc:  # pragma: no cover - runtime dependency issue
                raise RuntimeError(
                    "Failed to import FunASR dependencies. "
                    "Please install the desktop runtime dependencies first."
                ) from exc

            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            self._model = AutoModel(
                model=model_path,
                disable_update=True,
                log_level="ERROR",
                device=device,
            )
            self._loaded_model_path = model_path
            return self._model

    def _extract_text(self, result: Any) -> str:
        if isinstance(result, list) and result:
            first = result[0]
            if isinstance(first, dict):
                text = str(first.get("text") or "").strip()
                if text:
                    return text.split("|>")[-1].strip()

        if isinstance(result, dict):
            text = str(result.get("text") or "").strip()
            if text:
                return text.split("|>")[-1].strip()

        return str(result or "").strip()
