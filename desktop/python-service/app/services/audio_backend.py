"""Configure torchaudio's audio backend for the current platform.

On macOS we keep the default (torchcodec when installed), but on Windows/Linux
we force the `soundfile` backend so that torchaudio.load / torchaudio.save can
work without torchcodec (which has no Windows wheels).

This module is imported for side effects at service startup; it MUST NOT raise
if torchaudio is missing or if the backend cannot be changed — the caller might
not need audio I/O at all (pure API health checks, etc.).
"""

from __future__ import annotations

import logging
import sys

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
        import torchaudio  # type: ignore
    except Exception as exc:  # pragma: no cover - torchaudio missing is non-fatal
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
        import torchaudio  # type: ignore

        getter = getattr(torchaudio, "get_audio_backend", None)
        if callable(getter):
            return getter()
    except Exception:
        return None
    return None


configure_audio_backend()
