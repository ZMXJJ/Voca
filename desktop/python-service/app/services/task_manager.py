from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime

from app.models.schemas import (
    AppError,
    GenerationRequest,
    ModelPrepareResponse,
    TaskRecord,
    TaskResult,
)
from app.services.model_catalog import get_model_entry
from app.services.voxcpm_bridge import VoxCPMBridge


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, TaskRecord] = {}
        self._lock = threading.Lock()
        self._bridge = VoxCPMBridge()

    def is_model_loaded(self) -> bool:
        return self._bridge.is_model_loaded()

    def list_models(self):
        return self._bridge.list_models()

    def get_provider_recommendation(self, preferred: str = "auto"):
        return self._bridge.get_provider_recommendation(preferred)

    def prepare_model(
        self,
        model_key: str,
        provider_preference: str = "auto",
        *,
        ensure_downloaded: bool = False,
    ) -> ModelPrepareResponse:
        return self._bridge.prepare_model(
            model_key=model_key,
            provider_preference=provider_preference,
            ensure_downloaded=ensure_downloaded,
        )

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

    def list_tasks(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
    ) -> list[TaskRecord]:
        with self._lock:
            tasks = sorted(
                self._tasks.values(),
                key=lambda t: t.createdAt,
                reverse=True,
            )
        if status:
            tasks = [t for t in tasks if t.status == status]
        return tasks[offset : offset + limit]

    def _run_generate_task(self, task_id: str, payload: GenerationRequest) -> None:
        self._update_task(task_id, status="running", progress=10, message="Resolving model source")
        try:
            self._update_task(task_id, status="running", progress=35, message="Loading VoxCPM model")
            audio_path, sample_rate, duration_ms, model_key, provider = self._bridge.generate_audio(
                task_id=task_id,
                payload=payload,
            )
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="Audio generated successfully",
                result=TaskResult(
                    audioPath=audio_path,
                    sampleRate=sample_rate,
                    durationMs=duration_ms,
                    modelKey=model_key,
                    modelPath=self._bridge._loaded_model_path,
                    provider=provider,
                ),
            )
        except Exception as exc:  # pragma: no cover - environment-specific runtime fallback
            self._update_task(
                task_id,
                status="failed",
                progress=100,
                message="Failed to generate audio",
                error=AppError(
                    code="INFER_RUNTIME_ERROR",
                    message=str(exc),
                    userMessageKey="error.infer_runtime_error",
                    severity="error",
                    recoverable=True,
                    actions=["retry"],
                ),
            )

    def create_download_task(self, model_key: str, provider_preference: str = "auto") -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        task = TaskRecord(
            id=task_id,
            type="generate",
            status="queued",
            createdAt=now,
            updatedAt=now,
            progress=0,
            message=f"Preparing to download model {model_key}",
        )
        with self._lock:
            self._tasks[task_id] = task

        threading.Thread(
            target=self._run_download_task,
            args=(task_id, model_key, provider_preference),
            daemon=True,
        ).start()
        return task

    def _run_download_task(self, task_id: str, model_key: str, provider_preference: str) -> None:
        self._update_task(task_id, status="running", progress=5, message="Resolving download source")
        try:
            recommendation = self._bridge.get_provider_recommendation(provider_preference)
            provider = recommendation.current
            entry = get_model_entry(model_key)

            self._update_task(task_id, status="running", progress=15, message=f"Downloading from {provider}")

            result = self._bridge.prepare_model(
                model_key=model_key,
                provider_preference=provider_preference,
                ensure_downloaded=True,
            )

            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="Model downloaded successfully",
                result=TaskResult(
                    modelKey=model_key,
                    modelPath=result.modelPath,
                    provider=provider,
                ),
            )
        except Exception as exc:
            self._update_task(
                task_id,
                status="failed",
                progress=100,
                message="Failed to download model",
                error=AppError(
                    code="MODEL_DOWNLOAD_ERROR",
                    message=str(exc),
                    userMessageKey="error.model_download_error",
                    severity="error",
                    recoverable=True,
                    actions=["retry", "switch_download_source"],
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
