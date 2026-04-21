from __future__ import annotations

import logging
import threading
from pathlib import Path

from app.services.sensevoice_onnx_session import SenseVoiceOnnxSession

logger = logging.getLogger(__name__)

_TARGET_SAMPLE_RATE = 16000
_SUPPORTED_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".wma",
}


def _load_audio_as_ndarray(audio_path: str):
    """Load any audio format into a 16 kHz mono numpy array.

    Prefer librosa/audioread because in the packaged desktop runtime
    torchaudio's native loader can terminate the sidecar process outright
    while decoding reference audio, which makes the task table disappear
    before we can surface a normal error. soundfile is kept as a fallback
    for plain PCM/FLAC payloads.
    """

    import numpy as np

    ext = Path(audio_path).suffix.lower()
    if ext not in _SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported audio format '{ext}'. "
            f"Supported: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}"
        )

    try:
        import librosa  # type: ignore

        audio_data, _ = librosa.load(
            audio_path,
            sr=_TARGET_SAMPLE_RATE,
            mono=True,
            dtype=np.float32,
        )
        return np.asarray(audio_data, dtype=np.float32)
    except Exception as exc:
        logger.warning(
            "librosa.load failed for %s: %s — trying soundfile fallback",
            audio_path,
            exc,
        )

    try:
        import soundfile as sf  # type: ignore

        audio_data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
        audio_data = audio_data.mean(axis=1)
        if sr != _TARGET_SAMPLE_RATE:
            import librosa  # type: ignore

            audio_data = librosa.resample(
                audio_data, orig_sr=sr, target_sr=_TARGET_SAMPLE_RATE
            )
        return np.asarray(audio_data, dtype=np.float32)
    except Exception as sf_exc:
        logger.warning(
            "soundfile fallback also failed for %s: %s", audio_path, sf_exc
        )

    raise RuntimeError(
        f"Failed to decode audio file: {Path(audio_path).name} (format: {ext}). "
        f"Both librosa and soundfile backends failed. "
        f"Please try converting to WAV format and retry."
    )


class ASRBridge:
    """Thin wrapper around :class:`SenseVoiceOnnxSession`.

    It caches one ONNX session per model directory (which maps 1:1 to the
    local bootstrap path for ``sensevoice_small``). Thread-safe reloads are
    supported when the caller switches to a different model path.
    """

    def __init__(self) -> None:
        self._session: SenseVoiceOnnxSession | None = None
        self._loaded_model_path: str | None = None
        self._lock = threading.Lock()

    def is_model_loaded(self) -> bool:
        return self._session is not None

    def transcribe(
        self,
        audio_path: str,
        model_path: str,
        *,
        language: str = "auto",
        use_itn: bool = True,
    ) -> tuple[str, str | None]:
        audio_file = Path(audio_path)
        if not audio_file.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        audio_data = _load_audio_as_ndarray(audio_path)
        session = self._get_session(model_path)
        transcript, detected_language = session.transcribe(
            audio=audio_data,
            sample_rate=_TARGET_SAMPLE_RATE,
            language=language,
            use_itn=use_itn,
        )
        if not transcript:
            raise RuntimeError("SenseVoice returned an empty transcript")
        return transcript, detected_language

    def _get_session(self, model_path: str) -> SenseVoiceOnnxSession:
        with self._lock:
            if self._session is not None and self._loaded_model_path == model_path:
                return self._session

            logger.info("Loading SenseVoice ONNX session from %s", model_path)
            self._session = SenseVoiceOnnxSession(model_dir=model_path)
            self._loaded_model_path = model_path
            return self._session
