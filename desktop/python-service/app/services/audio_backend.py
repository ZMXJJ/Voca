"""Configure torchaudio's audio backend for the current platform.

On macOS we keep the default (torchcodec when installed), but on Windows/Linux
we force the `soundfile` backend so that torchaudio.load / torchaudio.save can
work without torchcodec (which has no Windows wheels).

Callers should invoke :func:`configure_audio_backend` right before they perform
torchaudio-based audio I/O. We intentionally avoid importing torchaudio during
service startup because that would lock the runtime package directories and
interfere with in-place CUDA runtime upgrades on Windows.
"""

from __future__ import annotations

import logging
import sys

from app.services.torch_runtime import import_torchaudio_clean, purge_torch_modules

_LOGGER = logging.getLogger(__name__)

_configured = False


def configure_audio_backend() -> str | None:
    """Idempotently set torchaudio's backend.

    Returns the backend name that is now active (or ``None`` when torchaudio is
    not importable).
    """

    global _configured
    if _configured:
        return _current_backend()

    _configured = True

    try:
        torchaudio = import_torchaudio_clean()
    except Exception as exc:  # pragma: no cover - torchaudio missing is non-fatal
        purge_torch_modules()
        _LOGGER.debug("torchaudio import failed; skipping audio backend setup: %s", exc)
        return None

    if sys.platform == "darwin":
        # macOS uses torchcodec (when present) or ffmpeg — do not override.
        return _current_backend()

    preferred_backends = ("soundfile",)
    last_error: Exception | None = None
    for backend in preferred_backends:
        try:
            torchaudio.set_audio_backend(backend)  # type: ignore[attr-defined]
            _LOGGER.info("torchaudio backend set to %s", backend)
            return backend
        except Exception as exc:  # pragma: no cover - best effort
            last_error = exc

    if last_error is not None:
        _LOGGER.warning("failed to switch torchaudio backend: %s", last_error)

    return _current_backend()


def _current_backend() -> str | None:
    try:
        torchaudio = import_torchaudio_clean(attempts=1)

        getter = getattr(torchaudio, "get_audio_backend", None)
        if callable(getter):
            return getter()
    except Exception:
        purge_torch_modules()
        return None
    return None
