"""Location resolution tests: every managed directory must honour its override."""

from __future__ import annotations

import tempfile
from pathlib import Path

from app.services import storage_paths


def test_app_support_dir_honours_override(voca_home):
    assert storage_paths.app_support_dir() == voca_home


def test_models_dir_honours_override(voca_home):
    expected = voca_home / "models"
    assert storage_paths.models_dir() == expected
    assert storage_paths.voices_dir() == voca_home / "voices"
    assert storage_paths.audio_output_dir() == voca_home / "outputs"
    assert storage_paths.logs_dir() == voca_home / "logs"


def test_legacy_audio_output_dirs_includes_temp_and_current(voca_home):
    dirs = storage_paths.legacy_audio_output_dirs()
    assert storage_paths.audio_output_dir() in dirs
    assert Path(tempfile.gettempdir()) / "voca" / "outputs" in dirs
