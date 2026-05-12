from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from types import ModuleType

_TORCH_MODULE_PREFIXES = (
    "torch",
    "torchaudio",
    "torchgen",
    "functorch",
    "torio",
)


def _ensure_runtime_overlay_on_path() -> None:
    """Add the Windows CUDA runtime overlay to ``sys.path`` if it exists
    but hasn't been injected yet.

    The Tauri launcher only adds ``runtime/site-packages`` to ``PYTHONPATH``
    when the overlay is already present at sidecar start-up. When the CUDA
    runtime is installed *during* the same sidecar session (first-run
    bootstrap), the directory is missing from ``sys.path`` and ``import
    torch`` fails. This function closes that gap by checking the env-var
    ``VOCA_RUNTIME_SITE_PACKAGES`` (always set by the launcher on Windows)
    and inserting the directory at the front of ``sys.path`` when the marker
    file confirms the install is complete.
    """
    overlay = os.environ.get("VOCA_RUNTIME_SITE_PACKAGES", "").strip()
    if not overlay:
        return
    overlay_path = Path(overlay)
    if not (overlay_path / "torch").exists():
        return
    resolved = str(overlay_path.resolve())
    if resolved not in sys.path:
        sys.path.insert(0, resolved)
        importlib.invalidate_caches()


def purge_torch_modules() -> None:
    for name in list(sys.modules.keys()):
        if name == _TORCH_MODULE_PREFIXES[0] or name.startswith(
            tuple(f"{prefix}." for prefix in _TORCH_MODULE_PREFIXES)
        ) or name in _TORCH_MODULE_PREFIXES[1:]:
            sys.modules.pop(name, None)
    importlib.invalidate_caches()


def _loaded_module(name: str, *, required_attr: str | None = None) -> ModuleType | None:
    module = sys.modules.get(name)
    if not isinstance(module, ModuleType):
        return None
    if required_attr and not hasattr(module, required_attr):
        return None
    return module


def import_torch_clean(*, attempts: int = 2, force_reload: bool = False) -> ModuleType:
    _ensure_runtime_overlay_on_path()
    last_error: BaseException | None = None
    loaded_torch = _loaded_module("torch", required_attr="_C")
    if loaded_torch is not None:
        # PyTorch's compiled extension keeps process-global state. On Windows,
        # purging ``sys.modules`` and importing again in the same process can
        # trip ``torch.overrides`` with "already has a docstring". A full sidecar
        # restart is the safe way to switch runtimes after torch has loaded once.
        if not force_reload or sys.platform == "win32":
            return loaded_torch
    if force_reload:
        purge_torch_modules()
    for attempt in range(1, attempts + 1):
        try:
            importlib.invalidate_caches()
            module = importlib.import_module("torch")
            if not hasattr(module, "_C"):
                raise AttributeError("module 'torch' has no attribute '_C'")
            return module
        except Exception as exc:
            last_error = exc
            purge_torch_modules()
            if attempt == attempts:
                raise
    assert last_error is not None
    raise last_error


def import_torchaudio_clean(*, attempts: int = 2, force_reload: bool = False) -> ModuleType:
    last_error: BaseException | None = None
    loaded_torchaudio = _loaded_module("torchaudio")
    if loaded_torchaudio is not None:
        if not force_reload or sys.platform == "win32":
            return loaded_torchaudio
    if force_reload:
        purge_torch_modules()
    for attempt in range(1, attempts + 1):
        try:
            import_torch_clean(attempts=1)
            importlib.invalidate_caches()
            module = importlib.import_module("torchaudio")
            return module
        except Exception as exc:
            last_error = exc
            purge_torch_modules()
            if attempt == attempts:
                raise
    assert last_error is not None
    raise last_error
