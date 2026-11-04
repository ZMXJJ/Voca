"""Shared fixtures for the Voca sidecar test suite.

Every test gets an isolated ``Voca`` application-support directory so nothing
touches the developer's real models/voices/outputs. ``storage_paths`` resolves
its locations from the environment on every call, so setting the env vars in a
fixture is enough — no module reloading required.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make ``import app...`` work when pytest is invoked from the service root.
SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


@pytest.fixture()
def voca_home(tmp_path, monkeypatch) -> Path:
    support = tmp_path / "Voca"
    support.mkdir()
    monkeypatch.setenv("VOCA_APP_SUPPORT_DIR", str(support))
    monkeypatch.setenv("VOCA_MODEL_DIR", str(support / "models"))
    return support


@pytest.fixture()
def model_dir(voca_home) -> Path:
    path = voca_home / "models" / "voxcpm2"
    path.mkdir(parents=True)
    (path / "config.json").write_text('{"model_type": "voxcpm"}', encoding="utf-8")
    (path / "model.safetensors").write_bytes(b"weights-v1" * 64)
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
    return path
