from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

from app.models.schemas import VoiceEntry

_VOICES_DIR = Path.home() / "Library" / "Application Support" / "Voca" / "voices"

BUILTIN_VOICES: list[VoiceEntry] = [
    VoiceEntry(id="builtin-female-gentle", name="女声-温柔", language="中文", isBuiltin=True),
    VoiceEntry(id="builtin-male-magnetic", name="男声-磁性", language="中文", isBuiltin=True),
    VoiceEntry(id="builtin-emma", name="Emma", language="English", isBuiltin=True),
    VoiceEntry(id="builtin-female-lively", name="女声-活泼", language="中文", isBuiltin=True),
    VoiceEntry(id="builtin-male-deep", name="男声-深沉", language="中文", isBuiltin=True),
    VoiceEntry(id="builtin-david", name="David", language="English", isBuiltin=True),
]


def _manifest_path() -> Path:
    return _VOICES_DIR / "manifest.json"


def _load_user_voices() -> list[VoiceEntry]:
    manifest = _manifest_path()
    if not manifest.exists():
        return []
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return [VoiceEntry(**entry) for entry in data]
    except Exception:
        return []


def _save_user_voices(voices: list[VoiceEntry]) -> None:
    _VOICES_DIR.mkdir(parents=True, exist_ok=True)
    manifest = _manifest_path()
    manifest.write_text(
        json.dumps([v.model_dump() for v in voices], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_voices() -> list[VoiceEntry]:
    return BUILTIN_VOICES + _load_user_voices()


def create_voice(name: str, language: str, audio_path: str) -> VoiceEntry:
    voice_id = f"user-{uuid.uuid4().hex[:12]}"

    _VOICES_DIR.mkdir(parents=True, exist_ok=True)
    src = Path(audio_path)
    if not src.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    dest = _VOICES_DIR / f"{voice_id}{src.suffix}"
    shutil.copy2(src, dest)

    entry = VoiceEntry(
        id=voice_id,
        name=name,
        language=language,
        audioPath=str(dest),
        isBuiltin=False,
    )

    user_voices = _load_user_voices()
    user_voices.append(entry)
    _save_user_voices(user_voices)
    return entry


def delete_voice(voice_id: str) -> bool:
    user_voices = _load_user_voices()
    target = next((v for v in user_voices if v.id == voice_id), None)
    if target is None:
        return False

    if target.audioPath:
        audio_file = Path(target.audioPath)
        if audio_file.exists():
            audio_file.unlink()

    updated = [v for v in user_voices if v.id != voice_id]
    _save_user_voices(updated)
    return True
