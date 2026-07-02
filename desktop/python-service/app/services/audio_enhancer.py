"""Torch-free speech denoiser for the Voca sidecar.

Backed by sherpa-onnx's ``OfflineSpeechDenoiser`` running the DPDFNet 48 kHz
high-res ONNX model. This replaces the previous PyTorch ZipEnhancer: same
onnxruntime ecosystem as the ASR engine, no torch dependency, and native
48 kHz (matching VoxCPM2's TTS output, so denoise no longer downsamples).

The model is a single ~10 MB ``.onnx`` file, resolved from (in order):
  1. ``VOCA_DENOISER_MODEL`` (explicit path)
  2. ``$VOCA_BUNDLE_RESOURCE_DIR/models/dpdfnet2_48khz_hr.onnx`` (bundled app)
  3. ``<models_dir>/dpdfnet_denoiser/dpdfnet2_48khz_hr.onnx`` (dev / on-disk)
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from app.services.storage_paths import audio_output_dir, models_dir

logger = logging.getLogger(__name__)

_DENOISER_FILENAME = "dpdfnet2_48khz_hr.onnx"


def _resolve_denoiser_model() -> Path:
    explicit = os.environ.get("VOCA_DENOISER_MODEL", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate
        raise RuntimeError(f"VOCA_DENOISER_MODEL points to a missing file: {explicit}")

    candidates: list[Path] = []
    bundle = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle:
        candidates.append(Path(bundle) / "models" / _DENOISER_FILENAME)
    candidates.append(models_dir() / "dpdfnet_denoiser" / _DENOISER_FILENAME)

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    raise RuntimeError(
        f"Denoiser model '{_DENOISER_FILENAME}' not found. Expected it under the "
        f"bundle 'models/' dir or {models_dir() / 'dpdfnet_denoiser'}. "
        "Set VOCA_DENOISER_MODEL to override."
    )


def _peak_normalize(audio: np.ndarray, target_peak: float = 0.99) -> np.ndarray:
    """Guard against clipping without materially changing perceived level."""
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak > 0 and peak > target_peak:
        return audio * (target_peak / peak)
    return audio


class AudioEnhancer:
    """Lazy-loaded, thread-safe DPDFNet denoiser (sherpa-onnx, torch-free)."""

    def __init__(self) -> None:
        self._denoiser = None
        self._loaded_model_path: str | None = None
        self._lock = threading.Lock()

    def is_loaded(self) -> bool:
        return self._denoiser is not None

    def enhance_file(self, input_path: str, output_stem: str) -> str:
        input_file = Path(input_path)
        if not input_file.exists():
            raise FileNotFoundError(f"Audio file not found: {input_path}")

        output_dir = audio_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{output_stem}_enhanced.wav"

        denoiser = self._load_denoiser()

        audio, sample_rate = sf.read(str(input_file), dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        result = denoiser.run(audio, sample_rate)
        enhanced = _peak_normalize(np.asarray(result.samples, dtype=np.float32))
        sf.write(str(output_path), enhanced, result.sample_rate)
        return str(output_path)

    def _load_denoiser(self):
        with self._lock:
            model_path = str(_resolve_denoiser_model())
            if self._denoiser is not None and self._loaded_model_path == model_path:
                return self._denoiser

            try:
                import sherpa_onnx  # type: ignore
            except Exception as exc:  # pragma: no cover - runtime dependency issue
                raise RuntimeError(
                    "Failed to import sherpa-onnx (denoiser runtime). "
                    "Please install the desktop runtime dependencies first."
                ) from exc

            num_threads = max(1, (os.cpu_count() or 2) - 1)
            config = sherpa_onnx.OfflineSpeechDenoiserConfig(
                model=sherpa_onnx.OfflineSpeechDenoiserModelConfig(
                    dpdfnet=sherpa_onnx.OfflineSpeechDenoiserDpdfNetModelConfig(
                        model=model_path
                    ),
                    num_threads=num_threads,
                    provider="cpu",
                )
            )
            if not config.validate():
                raise RuntimeError(f"Invalid denoiser configuration for model: {model_path}")

            self._denoiser = sherpa_onnx.OfflineSpeechDenoiser(config)
            self._loaded_model_path = model_path
            logger.info(
                "Loaded DPDFNet denoiser: %s (%d threads)", model_path, num_threads
            )
            return self._denoiser
