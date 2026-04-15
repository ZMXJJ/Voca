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


_SUPPORTED_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}


def _load_audio_as_ndarray(audio_path: str):
    """Load any audio format into a 16 kHz mono numpy array.

    Prefer librosa/audioread here instead of torchaudio. In the packaged
    desktop runtime, torchaudio's native loader can terminate the sidecar
    process outright while decoding reference audio, which makes the task
    table disappear before we can surface a normal error.

    Returns a 1-D float32 numpy array at 16 kHz, ready to be fed directly
    to FunASR's ``model.generate(input=ndarray)``, bypassing FunASR's own
    audio I/O entirely.
    """
    import numpy as np

    ext = Path(audio_path).suffix.lower()
    if ext not in _SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported audio format '{ext}'. "
            f"Supported: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}"
        )

    try:
        import librosa
        audio_data, _ = librosa.load(
            audio_path,
            sr=_TARGET_SAMPLE_RATE,
            mono=True,
            dtype=np.float32,
        )
        return np.asarray(audio_data, dtype=np.float32)
    except Exception as exc:
        logger.warning("librosa.load failed for %s: %s — trying soundfile fallback", audio_path, exc)

    try:
        import soundfile as sf
        audio_data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
        audio_data = audio_data.mean(axis=1)
        if sr != _TARGET_SAMPLE_RATE:
            import librosa
            audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=_TARGET_SAMPLE_RATE)
        return np.asarray(audio_data, dtype=np.float32)
    except Exception as sf_exc:
        logger.warning("soundfile fallback also failed for %s: %s", audio_path, sf_exc)

    raise RuntimeError(
        f"Failed to decode audio file: {Path(audio_path).name} (format: {ext}). "
        f"Both librosa and soundfile backends failed. "
        f"Please try converting to WAV format and retry."
    )


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
