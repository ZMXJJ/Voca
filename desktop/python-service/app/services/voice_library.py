from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import uuid
import wave
from datetime import UTC, datetime
from pathlib import Path

from app.models.schemas import VoiceEntry
from app.services.storage_paths import app_support_dir, database_path, voices_dir

_VOICES_DIR = voices_dir()
_DB_PATH = database_path()
_LEGACY_MANIFEST_PATH = _VOICES_DIR / "manifest.json"
_INIT_LOCK = threading.Lock()
_INITIALIZED = False

DEFAULT_VOICES: tuple[dict[str, str], ...] = (
    {
        "id": "builtin-female-default",
        "name": "默认女声",
        "language": "中文",
        "description": (
            "温柔清晰的中文女声，语气自然、明亮，适合讲述、说明和陪伴类内容。"
        ),
        "preset_key": "female_default",
    },
    {
        "id": "builtin-male-default",
        "name": "默认男声",
        "language": "中文",
        "description": (
            "沉稳自然的中文男声，吐字清楚、节奏平稳，适合解说、播报和知识类内容。"
        ),
        "preset_key": "male_default",
    },
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _connect() -> sqlite3.Connection:
    app_support_dir().mkdir(parents=True, exist_ok=True)
    _VOICES_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(_DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def _ensure_initialized() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return

    with _INIT_LOCK:
        if _INITIALIZED:
            return

        with _connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS voices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    language TEXT NOT NULL,
                    description TEXT NOT NULL,
                    reference_audio_path TEXT,
                    reference_transcript TEXT,
                    transcript_language TEXT,
                    duration_seconds REAL,
                    source_type TEXT NOT NULL CHECK(source_type IN ('builtin', 'user')),
                    preset_key TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            _ensure_voice_columns(connection)
            _seed_default_voices(connection)
            _migrate_legacy_manifest(connection)
            connection.commit()

        _INITIALIZED = True


def _seed_default_voices(connection: sqlite3.Connection) -> None:
    for item in DEFAULT_VOICES:
        now = _now_iso()
        connection.execute(
            """
            INSERT OR IGNORE INTO voices (
                id,
                name,
                language,
                description,
                reference_audio_path,
                reference_transcript,
                transcript_language,
                duration_seconds,
                source_type,
                preset_key,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'builtin', ?, ?, ?)
            """,
            (
                item["id"],
                item["name"],
                item["language"],
                item["description"],
                item["preset_key"],
                now,
                now,
            ),
        )


def _migrate_legacy_manifest(connection: sqlite3.Connection) -> None:
    if not _LEGACY_MANIFEST_PATH.exists():
        return

    try:
        payload = json.loads(_LEGACY_MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return

    if not isinstance(payload, list):
        return

    for item in payload:
        if not isinstance(item, dict):
            continue

        voice_id = str(item.get("id") or f"user-{uuid.uuid4().hex[:12]}")
        created_at = str(item.get("createdAt") or _now_iso())
        updated_at = str(item.get("updatedAt") or created_at)
        reference_audio_path = item.get("referenceAudioPath") or item.get("audioPath")
        reference_transcript = item.get("referenceTranscript")
        transcript_language = item.get("transcriptLanguage")

        connection.execute(
            """
            INSERT OR IGNORE INTO voices (
                id,
                name,
                language,
                description,
                reference_audio_path,
                reference_transcript,
                transcript_language,
                duration_seconds,
                source_type,
                preset_key,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?, ?)
            """,
            (
                voice_id,
                str(item.get("name") or "未命名音色"),
                str(item.get("language") or "中文"),
                str(item.get("description") or ""),
                str(reference_audio_path) if reference_audio_path else None,
                str(reference_transcript).strip() if reference_transcript else None,
                str(transcript_language).strip() if transcript_language else None,
                item.get("durationSeconds"),
                created_at,
                updated_at,
            ),
        )


def _ensure_voice_columns(connection: sqlite3.Connection) -> None:
    existing_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(voices)").fetchall()
    }
    if "reference_transcript" not in existing_columns:
        connection.execute("ALTER TABLE voices ADD COLUMN reference_transcript TEXT")
    if "transcript_language" not in existing_columns:
        connection.execute("ALTER TABLE voices ADD COLUMN transcript_language TEXT")


def _estimate_duration_seconds(path: Path) -> float | None:
    if path.suffix.lower() != ".wav":
        return None

    try:
        with wave.open(str(path), "rb") as wav_file:
            frame_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            if frame_rate <= 0:
                return None
            return round(frame_count / frame_rate, 2)
    except Exception:
        return None


def _copy_reference_audio(voice_id: str, source_path: str | None) -> tuple[str | None, float | None]:
    if not source_path:
        return None, None

    src = Path(source_path)
    if not src.exists():
        raise FileNotFoundError(f"Audio file not found: {source_path}")

    dest = _VOICES_DIR / f"{voice_id}{src.suffix}"
    shutil.copy2(src, dest)
    return str(dest), _estimate_duration_seconds(dest)


def _row_to_voice(row: sqlite3.Row) -> VoiceEntry:
    source_type = str(row["source_type"])
    is_user_voice = source_type == "user"
    return VoiceEntry(
        id=str(row["id"]),
        name=str(row["name"]),
        language=str(row["language"]),
        description=str(row["description"]),
        durationSeconds=row["duration_seconds"],
        referenceAudioPath=row["reference_audio_path"],
        referenceTranscript=row["reference_transcript"],
        transcriptLanguage=row["transcript_language"],
        sourceType=source_type,
        canRename=is_user_voice,
        canDelete=is_user_voice,
        presetKey=row["preset_key"],
        createdAt=str(row["created_at"]),
        updatedAt=str(row["updated_at"]),
    )


def list_voices() -> list[VoiceEntry]:
    _ensure_initialized()
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM voices
            ORDER BY
                CASE source_type WHEN 'builtin' THEN 0 ELSE 1 END,
                created_at DESC
            """
        ).fetchall()
    return [_row_to_voice(row) for row in rows]


def get_voice(voice_id: str) -> VoiceEntry | None:
    _ensure_initialized()
    with _connect() as connection:
        row = connection.execute("SELECT * FROM voices WHERE id = ?", (voice_id,)).fetchone()
    return _row_to_voice(row) if row else None


def create_voice(
    name: str,
    language: str,
    description: str,
    reference_audio_path: str | None = None,
    reference_transcript: str | None = None,
    transcript_language: str | None = None,
) -> VoiceEntry:
    _ensure_initialized()
    voice_id = f"user-{uuid.uuid4().hex[:12]}"
    now = _now_iso()
    stored_audio_path, duration_seconds = _copy_reference_audio(voice_id, reference_audio_path)

    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO voices (
                id,
                name,
                language,
                description,
                reference_audio_path,
                reference_transcript,
                transcript_language,
                duration_seconds,
                source_type,
                preset_key,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?, ?)
            """,
            (
                voice_id,
                name.strip(),
                language.strip(),
                description.strip(),
                stored_audio_path,
                reference_transcript.strip() if reference_transcript else None,
                transcript_language.strip() if transcript_language else None,
                duration_seconds,
                now,
                now,
            ),
        )
        connection.commit()

    created = get_voice(voice_id)
    if created is None:  # pragma: no cover - defensive guard
        raise RuntimeError("Failed to create voice")
    return created


def update_voice(
    voice_id: str,
    *,
    name: str | None = None,
    language: str | None = None,
    description: str | None = None,
    reference_transcript: str | None = None,
    transcript_language: str | None = None,
) -> VoiceEntry | None:
    _ensure_initialized()
    existing = get_voice(voice_id)
    if existing is None:
        return None
    if existing.sourceType != "user":
        raise PermissionError("Built-in voices are read-only")

    updated_name = name.strip() if name is not None else existing.name
    updated_language = language.strip() if language is not None else existing.language
    updated_description = description.strip() if description is not None else existing.description
    updated_reference_transcript = (
        reference_transcript.strip() if reference_transcript is not None else existing.referenceTranscript
    )
    updated_transcript_language = (
        transcript_language.strip() if transcript_language is not None else existing.transcriptLanguage
    )

    with _connect() as connection:
        connection.execute(
            """
            UPDATE voices
            SET
                name = ?,
                language = ?,
                description = ?,
                reference_transcript = ?,
                transcript_language = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                updated_name,
                updated_language,
                updated_description,
                updated_reference_transcript,
                updated_transcript_language,
                _now_iso(),
                voice_id,
            ),
        )
        connection.commit()

    return get_voice(voice_id)


def delete_voice(voice_id: str) -> bool:
    _ensure_initialized()
    existing = get_voice(voice_id)
    if existing is None:
        return False
    if existing.sourceType != "user":
        raise PermissionError("Built-in voices cannot be deleted")

    if existing.referenceAudioPath:
        audio_file = Path(existing.referenceAudioPath)
        if audio_file.exists():
            audio_file.unlink()

    with _connect() as connection:
        connection.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
        connection.commit()
    return True
