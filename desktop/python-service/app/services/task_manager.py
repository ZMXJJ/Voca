from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime

from app.models.schemas import AppError, GenerationRequest, TaskRecord, TaskResult
from app.services.voxcpm_bridge import VoxCPMBridge


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, TaskRecord] = {}
        self._lock = threading.Lock()
        self._bridge = VoxCPMBridge()

    def create_generate_task(self, payload: GenerationRequest) -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        task = TaskRecord(
            id=task_id,
            type="generate",
            status="queued",
            createdAt=now,
            updatedAt=now,
            progress=0,
            message=f"P0 skeleton accepted task in mode {payload.mode}",
        )
        with self._lock:
            self._tasks[task_id] = task

        threading.Thread(
            target=self._run_generate_task,
            args=(task_id, payload),
            daemon=True,
        ).start()
        return task

    def get_task(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            return self._tasks.get(task_id)

    def _run_generate_task(self, task_id: str, payload: GenerationRequest) -> None:
        self._update_task(task_id, status="running", progress=35, message="Generating placeholder audio")
        try:
            audio_path, sample_rate, duration_ms = self._bridge.generate_placeholder_audio(
                task_id=task_id,
                target_text=payload.targetText,
            )
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="Placeholder audio generated",
                result=TaskResult(
                    audioPath=audio_path,
                    sampleRate=sample_rate,
                    durationMs=duration_ms,
                ),
            )
        except Exception as exc:  # pragma: no cover - placeholder error fallback
            self._update_task(
                task_id,
                status="failed",
                progress=100,
                message="Failed to generate placeholder audio",
                error=AppError(
                    code="INFER_RUNTIME_ERROR",
                    message=str(exc),
                    userMessageKey="error.infer_runtime_error",
                    severity="error",
                    recoverable=True,
                    actions=["retry"],
                ),
            )

    def _update_task(
        self,
        task_id: str,
        *,
        status: str,
        progress: int,
        message: str,
        result: TaskResult | None = None,
        error: AppError | None = None,
    ) -> None:
        with self._lock:
            task = self._tasks[task_id]
            task.status = status
            task.progress = progress
            task.message = message
            task.updatedAt = datetime.now(UTC).isoformat()
            task.result = result
            task.error = error
