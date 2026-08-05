from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

from app.models.schemas import GenerationRequest, WorkEntry, WorkImportItem, WorkVoiceFacet
from app.services import voice_library
from app.services.storage_paths import app_support_dir, database_path

_DB_PATH = database_path()
_INIT_LOCK = threading.Lock()
_INITIALIZED = False
_TITLE_MAX_LENGTH = 80
_logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _connect() -> sqlite3.Connection:
    app_support_dir().mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(_DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def _reconcile_work_audio(connection: sqlite3.Connection) -> None:
    """Drop work records whose playable audio file no longer exists."""
    rows = connection.execute("SELECT id, audio_path FROM works").fetchall()
    missing = [
        str(row["id"])
        for row in rows
        if not Path(str(row["audio_path"])).exists()
    ]
    if not missing:
        return

    placeholders = ",".join("?" for _ in missing)
    connection.execute(f"DELETE FROM works WHERE id IN ({placeholders})", missing)
    _logger.warning(
        "Removed %d work(s) whose audio file is missing on disk", len(missing)
    )


def _ensure_initialized() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return

    with _INIT_LOCK:
        if _INITIALIZED:
            return

        # voca.db is shared with the voice library; its init owns the
        # integrity check / backup-restore pass, so run it first.
        voice_library._ensure_initialized()

        with _connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS works (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    target_text TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    model_key TEXT,
                    voice_id TEXT,
                    voice_name TEXT,
                    cfg_value REAL,
                    inference_timesteps INTEGER,
                    seed INTEGER,
                    normalize INTEGER,
                    denoise INTEGER,
                    extreme_clone INTEGER,
                    audio_path TEXT NOT NULL,
                    raw_audio_path TEXT,
                    enhanced_audio_path TEXT,
                    sample_rate INTEGER,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_works_created_at ON works(created_at DESC)"
            )
            _reconcile_work_audio(connection)
            connection.commit()

        voice_library._write_backup()
        _INITIALIZED = True


def _derive_title(text: str) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:_TITLE_MAX_LENGTH] or "Untitled"


def _to_flag(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _from_flag(value: object) -> bool | None:
    if value is None:
        return None
    return bool(value)


def _row_to_work(row: sqlite3.Row) -> WorkEntry:
    return WorkEntry(
        id=str(row["id"]),
        title=str(row["title"]),
        targetText=str(row["target_text"]),
        mode=str(row["mode"]),
        modelKey=row["model_key"],
        voiceId=row["voice_id"],
        voiceName=row["voice_name"],
        cfgValue=row["cfg_value"],
        inferenceTimesteps=row["inference_timesteps"],
        seed=row["seed"],
        normalize=_from_flag(row["normalize"]),
        denoise=_from_flag(row["denoise"]),
        extremeClone=_from_flag(row["extreme_clone"]),
        audioPath=str(row["audio_path"]),
        rawAudioPath=row["raw_audio_path"],
        enhancedAudioPath=row["enhanced_audio_path"],
        sampleRate=row["sample_rate"],
        durationMs=row["duration_ms"],
        createdAt=str(row["created_at"]),
        updatedAt=str(row["updated_at"]),
    )


def record_work(
    *,
    work_id: str,
    payload: GenerationRequest,
    audio_path: str,
    raw_audio_path: str | None,
    enhanced_audio_path: str | None,
    sample_rate: int | None,
    duration_ms: int | None,
) -> WorkEntry | None:
    _ensure_initialized()
    now = _now_iso()

    with _connect() as connection:
        connection.execute(
            """
            INSERT OR IGNORE INTO works (
                id, title, target_text, mode, model_key, voice_id, voice_name,
                cfg_value, inference_timesteps, seed, normalize, denoise,
                extreme_clone, audio_path, raw_audio_path, enhanced_audio_path,
                sample_rate, duration_ms, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                work_id,
                _derive_title(payload.targetText),
                payload.targetText,
                payload.mode,
                payload.modelKey,
                payload.voiceId,
                payload.voiceName,
                payload.cfgValue,
                payload.inferenceTimesteps,
                payload.seed,
                _to_flag(payload.normalize),
                _to_flag(payload.denoise),
                _to_flag(payload.extremeClone),
                audio_path,
                raw_audio_path,
                enhanced_audio_path,
                sample_rate,
                duration_ms,
                now,
                now,
            ),
        )
        connection.commit()

    voice_library._write_backup()
    return get_work(work_id)


def _build_filters(
    search: str | None,
    voice_id: str | None,
    voice_name: str | None,
) -> tuple[str, list[object]]:
    clauses: list[str] = []
    params: list[object] = []
    if search:
        like = f"%{search}%"
        clauses.append("(target_text LIKE ? OR title LIKE ? OR voice_name LIKE ?)")
        params.extend([like, like, like])
    if voice_id:
        clauses.append("voice_id = ?")
        params.append(voice_id)
    elif voice_name:
        clauses.append("voice_name = ?")
        params.append(voice_name)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def list_works(
    *,
    limit: int = 50,
    offset: int = 0,
    search: str | None = None,
    voice_id: str | None = None,
    voice_name: str | None = None,
) -> tuple[list[WorkEntry], int]:
    _ensure_initialized()
    where, params = _build_filters(search, voice_id, voice_name)

    with _connect() as connection:
        total_row = connection.execute(
            f"SELECT COUNT(*) FROM works{where}", params
        ).fetchone()
        rows = connection.execute(
            f"SELECT * FROM works{where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()

    return [_row_to_work(row) for row in rows], int(total_row[0])


def get_work(work_id: str) -> WorkEntry | None:
    _ensure_initialized()
    with _connect() as connection:
        row = connection.execute("SELECT * FROM works WHERE id = ?", (work_id,)).fetchone()
    return _row_to_work(row) if row else None


def rename_work(work_id: str, title: str) -> WorkEntry | None:
    _ensure_initialized()
    cleaned = title.strip()
    if not cleaned:
        raise ValueError("Title cannot be empty")

    with _connect() as connection:
        cursor = connection.execute(
            "UPDATE works SET title = ?, updated_at = ? WHERE id = ?",
            (cleaned[:_TITLE_MAX_LENGTH], _now_iso(), work_id),
        )
        connection.commit()

    if cursor.rowcount == 0:
        return None
    voice_library._write_backup()
    return get_work(work_id)


def delete_work(work_id: str) -> bool:
    _ensure_initialized()
    existing = get_work(work_id)
    if existing is None:
        return False

    for path_value in (existing.audioPath, existing.rawAudioPath, existing.enhancedAudioPath):
        if not path_value:
            continue
        try:
            Path(path_value).unlink(missing_ok=True)
        except OSError as exc:
            _logger.warning("Failed to delete work audio file %s: %s", path_value, exc)

    with _connect() as connection:
        connection.execute("DELETE FROM works WHERE id = ?", (work_id,))
        connection.commit()
    voice_library._write_backup()
    return True


def list_voice_facets() -> list[WorkVoiceFacet]:
    _ensure_initialized()
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT voice_id, voice_name, COUNT(*) AS count
            FROM works
            GROUP BY voice_id, voice_name
            ORDER BY count DESC
            """
        ).fetchall()
    return [
        WorkVoiceFacet(
            voiceId=row["voice_id"],
            voiceName=row["voice_name"],
            count=int(row["count"]),
        )
        for row in rows
    ]


def import_works(items: list[WorkImportItem]) -> tuple[int, int]:
    """Bulk-import legacy localStorage history records.

    Rows are keyed by the legacy task id, so replays are idempotent via
    ``INSERT OR IGNORE``. Items whose audio no longer exists on disk are
    skipped — there is nothing to play or export for them.
    """
    _ensure_initialized()
    imported = 0
    skipped = 0

    with _connect() as connection:
        for item in items:
            if not item.audioPath or not Path(item.audioPath).exists():
                skipped += 1
                continue

            target_text = (item.targetText or item.title or "").strip()
            created_at = item.createdAt or _now_iso()
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO works (
                    id, title, target_text, mode, model_key, voice_id, voice_name,
                    cfg_value, inference_timesteps, seed, normalize, denoise,
                    extreme_clone, audio_path, raw_audio_path, enhanced_audio_path,
                    sample_rate, duration_ms, created_at, updated_at
                ) VALUES (?, ?, ?, 'legacy_import', NULL, NULL, ?, NULL, NULL, NULL,
                          NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    _derive_title(item.title or target_text or "Untitled"),
                    target_text,
                    item.voiceName,
                    item.audioPath,
                    item.rawAudioPath,
                    item.enhancedAudioPath,
                    item.sampleRate,
                    item.durationMs,
                    created_at,
                    created_at,
                ),
            )
            if cursor.rowcount > 0:
                imported += 1
            else:
                skipped += 1
        connection.commit()

    if imported:
        voice_library._write_backup()
    return imported, skipped


def _is_under_dirs(path_value: str | None, dirs: list[Path]) -> bool:
    if not path_value:
        return False
    try:
        resolved = Path(path_value).resolve()
    except OSError:
        return False
    for directory in dirs:
        try:
            resolved_dir = directory.resolve()
        except OSError:
            continue
        if resolved == resolved_dir or resolved_dir in resolved.parents:
            return True
    return False


def delete_works_under_dirs(dirs: list[Path]) -> list[str]:
    """Remove work rows whose audio lives under any of ``dirs``.

    Used by the cache-clear route, which deletes the files itself — this only
    keeps the works table consistent with the wiped output directories.
    """
    _ensure_initialized()
    removed: list[str] = []

    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, audio_path, raw_audio_path, enhanced_audio_path FROM works"
        ).fetchall()
        for row in rows:
            candidates = (
                row["audio_path"],
                row["raw_audio_path"],
                row["enhanced_audio_path"],
            )
            if any(_is_under_dirs(candidate, dirs) for candidate in candidates):
                removed.append(str(row["id"]))

        if removed:
            placeholders = ",".join("?" for _ in removed)
            connection.execute(f"DELETE FROM works WHERE id IN ({placeholders})", removed)
            connection.commit()

    if removed:
        voice_library._write_backup()
    return removed
