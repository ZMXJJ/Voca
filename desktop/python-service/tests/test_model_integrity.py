"""Regression tests for the model staging / manifest / promotion pipeline.

This is the code path that decides whether a multi-GB download becomes visible
to the user, so the important properties are: manifests describe exactly the
files that were downloaded, quick verification catches missing/truncated files,
full verification catches same-size content tampering, promotion is atomic and
quarantines the previous copy instead of deleting it eagerly.
"""

from __future__ import annotations

import hashlib
import json
import time

import pytest

from app.services import model_integrity
from app.services.model_integrity import (
    MANIFEST_FILENAME,
    cleanup_orphans,
    compute_manifest,
    load_manifest,
    promote_staging_to_final,
    stage_dir,
    trash_root,
    verify_full,
    verify_quick,
    write_manifest,
)


def _sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest_files(payload: dict) -> dict[str, dict]:
    return {entry["path"]: entry for entry in payload["files"]}


def test_compute_manifest_hashes_every_file_except_hidden_and_manifest(model_dir):
    (model_dir / ".cache").mkdir()
    (model_dir / ".cache" / "ignored.bin").write_bytes(b"nope")
    (model_dir / MANIFEST_FILENAME).write_text("{}", encoding="utf-8")

    manifest = compute_manifest(model_dir, model_key="voxcpm2", provider="huggingface")
    files = _manifest_files(manifest)

    assert manifest["version"] == model_integrity.MANIFEST_VERSION
    assert manifest["modelKey"] == "voxcpm2"
    assert manifest["provider"] == "huggingface"
    assert set(files) == {"config.json", "model.safetensors", "tokenizer.json"}
    for relative, entry in files.items():
        target = model_dir / relative
        assert entry["size"] == target.stat().st_size
        assert entry["sha256"] == _sha256(target)


def test_manifest_roundtrip_and_rejects_bad_payloads(model_dir, tmp_path):
    write_manifest(model_dir, compute_manifest(model_dir, model_key="voxcpm2"))
    assert load_manifest(model_dir) is not None

    (model_dir / MANIFEST_FILENAME).write_text("{not json", encoding="utf-8")
    assert load_manifest(model_dir) is None

    (model_dir / MANIFEST_FILENAME).write_text(
        json.dumps({"version": 999, "files": []}), encoding="utf-8"
    )
    assert load_manifest(model_dir) is None


def test_verify_quick_detects_missing_and_truncated_files(model_dir):
    write_manifest(model_dir, compute_manifest(model_dir, model_key="voxcpm2"))

    assert verify_quick(model_dir).ok

    (model_dir / "tokenizer.json").unlink()
    missing = verify_quick(model_dir)
    assert not missing.ok
    assert "missing file" in (missing.reason or "")

    (model_dir / "tokenizer.json").write_text("{}", encoding="utf-8")
    (model_dir / "model.safetensors").write_bytes(b"short")
    truncated = verify_quick(model_dir)
    assert not truncated.ok
    assert "size mismatch" in (truncated.reason or "")


def test_verify_full_catches_same_size_content_tampering(model_dir):
    """Quick verification only compares sizes for big weights; full must hash."""

    write_manifest(model_dir, compute_manifest(model_dir, model_key="voxcpm2"))
    weights = model_dir / "model.safetensors"
    original = weights.read_bytes()
    weights.write_bytes(b"X" * len(original))

    assert verify_quick(model_dir).ok, "size-only check is expected to pass"
    full = verify_full(model_dir)
    assert not full.ok
    assert "sha256 mismatch" in (full.reason or "")


def test_verify_without_manifest_fails_closed(model_dir):
    result = verify_quick(model_dir)
    assert not result.ok
    assert result.reason == "manifest missing"


def test_promote_replaces_target_and_quarantines_previous_copy(voca_home, monkeypatch):
    final = voca_home / "models" / "voxcpm2"
    staging = stage_dir("voxcpm2")
    staging.mkdir(parents=True)
    (staging / "config.json").write_text('{"v": 2}', encoding="utf-8")

    final.mkdir(parents=True)
    (final / "config.json").write_text('{"v": 1}', encoding="utf-8")

    scheduled: list = []
    monkeypatch.setattr(model_integrity, "_schedule_rmtree", scheduled.append)

    promote_staging_to_final(staging, final)

    assert not staging.exists()
    assert json.loads((final / "config.json").read_text(encoding="utf-8")) == {"v": 2}
    assert len(scheduled) == 1
    quarantined = scheduled[0]
    assert quarantined.parent == trash_root()
    assert json.loads((quarantined / "config.json").read_text(encoding="utf-8")) == {"v": 1}


def test_promote_requires_existing_staging(voca_home):
    final = voca_home / "models" / "voxcpm2"
    with pytest.raises(FileNotFoundError):
        promote_staging_to_final(stage_dir("voxcpm2"), final)


def test_cleanup_orphans_removes_only_stale_entries(voca_home):
    trash = trash_root()
    trash.mkdir(parents=True)
    stale = trash / "voxcpm2-old"
    stale.mkdir()
    (stale / "x.bin").write_bytes(b"x")
    old = time.time() - 10 * 24 * 60 * 60
    import os

    os.utime(stale, (old, old))

    staging = stage_dir("voxcpm2")
    staging.mkdir(parents=True)
    (staging / "partial.bin").write_bytes(b"y")

    cleanup_orphans()

    assert not stale.exists(), "stale .trash entry should be removed"
    assert staging.exists(), "fresh staging directory must be kept"
