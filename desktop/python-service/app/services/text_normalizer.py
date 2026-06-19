"""Backend-independent text normalization for the TTS pipeline.

The original Python VoxCPM engine normalizes text internally when
``generate(normalize=True)`` is requested (numbers, dates, abbreviations,
symbol expansion, …). The C++ ``llama.cpp-omni`` backend has **no** text
normalization frontend — it tokenizes raw text. To keep parity when the C++
backend is selected, normalization must happen here, in Python, before the
text is handed to the native binary.

We reuse VoxCPM's own ``TextNormalizer`` (``VoxCPM/src/voxcpm/utils/
text_normalize.py``) so the normalized output matches the legacy path exactly.
That module is fully torch-free (only ``re``/``regex``/``inflect``/``wetext``)
and uses no relative imports, so we load it **by file path** via importlib —
importing ``voxcpm.utils.text_normalize`` as a submodule would execute
``voxcpm/__init__.py`` → ``core`` → torch, which is exactly the heavy
dependency this migration is trying to drop.

If ``wetext``/``inflect`` are unavailable (e.g. a stripped runtime), we fall
back to returning the text unchanged so generation still succeeds.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_NORMALIZER: Any | None = None
_LOAD_ATTEMPTED = False


def _resolve_text_normalize_path() -> Path | None:
    """Locate VoxCPM's ``utils/text_normalize.py`` source file."""

    explicit_src = os.environ.get("VOCA_VOXCPM_SRC", "").strip()
    candidates = []
    if explicit_src:
        candidates.append(Path(explicit_src))

    bundle_resource_dir = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle_resource_dir:
        candidates.append(Path(bundle_resource_dir) / "VoxCPM" / "src")

    # repo_root/VoxCPM/src — this file lives at
    # desktop/python-service/app/services/text_normalizer.py
    repo_root = Path(__file__).resolve().parents[4]
    candidates.append(repo_root / "VoxCPM" / "src")

    for src in candidates:
        candidate = src / "voxcpm" / "utils" / "text_normalize.py"
        if candidate.exists():
            return candidate
    return None


def _load_normalizer() -> Any | None:
    """Load and cache VoxCPM's ``TextNormalizer`` by file path (torch-free)."""

    global _NORMALIZER, _LOAD_ATTEMPTED
    with _LOCK:
        if _LOAD_ATTEMPTED:
            return _NORMALIZER
        _LOAD_ATTEMPTED = True

        module_path = _resolve_text_normalize_path()
        if module_path is None:
            logger.warning(
                "text_normalize.py not found; TTS text normalization will pass through unchanged."
            )
            return None

        try:
            spec = importlib.util.spec_from_file_location(
                "voca_voxcpm_text_normalize", str(module_path)
            )
            if spec is None or spec.loader is None:
                return None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _NORMALIZER = module.TextNormalizer()
            logger.info("Loaded VoxCPM TextNormalizer from %s", module_path)
        except Exception:
            # Missing wetext/inflect, or a wetext model failure — degrade to
            # passthrough rather than failing generation outright.
            logger.exception(
                "Failed to initialize TextNormalizer; falling back to passthrough."
            )
            _NORMALIZER = None
        return _NORMALIZER


def normalize_text(text: str) -> str:
    """Normalize ``text`` for TTS, matching VoxCPM's internal frontend.

    Returns the input unchanged if no normalizer is available.
    """

    if not text:
        return text
    normalizer = _load_normalizer()
    if normalizer is None:
        return text
    try:
        return normalizer.normalize(text)
    except Exception:
        logger.exception("TextNormalizer.normalize failed; returning original text.")
        return text
