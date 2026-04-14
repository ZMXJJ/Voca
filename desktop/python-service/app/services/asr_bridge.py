from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


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

_TARGET_SAMPLE_RATE = 16000


def _load_audio_as_ndarray(audio_path: str):
    """Load any audio format into a 16 kHz mono numpy array.

    Uses torchaudio's built-in FFmpeg C++ bindings (shipped inside the
    torchaudio wheel) so the app never needs a system ``ffmpeg`` CLI.
    Returns a 1-D float32 numpy array at 16 kHz — ready to be fed
    directly to FunASR's ``model.generate(input=ndarray)``, bypassing
    FunASR's own audio I/O entirely.
    """
    import numpy as np
    import torchaudio

    waveform, sr = torchaudio.load(audio_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != _TARGET_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sr, _TARGET_SAMPLE_RATE)

    return waveform.squeeze(0).numpy().astype(np.float32)


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

        audio_data = _load_audio_as_ndarray(audio_path)
        model = self._load_model(model_path)
        result = model.generate(input=audio_data, language="auto", use_itn=True)

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
