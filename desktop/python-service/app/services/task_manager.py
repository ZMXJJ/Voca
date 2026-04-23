from __future__ import annotations

import logging
import os
import queue
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

from app.models.schemas import (
    AppError,
    BootstrapAssetDownloadProgress,
    DownloadProgress,
    GenerationRequest,
    ModelPrepareResponse,
    TaskRecord,
    TaskResult,
)
from app.services.asr_bridge import ASRBridge
from app.services.bootstrap_assets import bootstrap_entries
from app.services.model_catalog import get_model_entry
from app.services.voxcpm_bridge import DownloadProgressEvent, VoxCPMBridge


def _format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(max(value, 0))
    unit_index = 0
    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1
    precision = 0 if unit_index == 0 else 1
    return f"{size:.{precision}f} {units[unit_index]}"


def _derive_download_progress(progress: DownloadProgress) -> int:
    if progress.phase == "finalizing":
        return 99

    file_progress = 0
    if progress.totalFiles and progress.totalFiles > 0:
        ratio = progress.completedFiles / progress.totalFiles
        file_progress = max(0, min(int(ratio * 100), 99))
        if file_progress == 0 and (progress.downloadedBytes > 0 or progress.currentFile):
            file_progress = 1

    if progress.totalBytesComplete and progress.totalBytes and progress.totalBytes > 0:
        ratio = progress.downloadedBytes / progress.totalBytes
        computed = max(0, min(int(ratio * 100), 99))
        if progress.downloadedBytes > 0:
            return max(computed, file_progress, 1)
        return max(computed, file_progress)

    if progress.totalBytes and progress.totalBytes > 0 and progress.downloadedBytes > 0:
        remaining_files = None
        if progress.totalFiles and progress.totalFiles > 0:
            remaining_files = max(progress.totalFiles - progress.completedFiles, 0)

        allow_partial_byte_progress = (
            remaining_files is None
            or remaining_files <= 2
            or (progress.totalFiles == 1)
        )
        if not allow_partial_byte_progress:
            return file_progress if file_progress > 0 else 1

        ratio = progress.downloadedBytes / progress.totalBytes
        computed = max(0, min(int(ratio * 100), 99))
        if remaining_files is not None and progress.totalFiles and progress.totalFiles > 1:
            segmented = file_progress + int((99 - file_progress) * min(max(ratio, 0.0), 1.0))
            return max(min(segmented, 99), file_progress, 1)
        return max(computed, file_progress, 1)

    if file_progress > 0:
        return file_progress

    if progress.phase == "downloading" and (progress.downloadedBytes > 0 or progress.currentFile):
        return 1

    return 0


def _download_message(progress: DownloadProgress, model_name: str) -> str:
    if progress.phase == "listing":
        return f"Resolving download manifest for {model_name}"

    if progress.phase == "finalizing":
        return f"Verifying downloaded files for {model_name}"

    if progress.totalBytesComplete and progress.totalBytes and progress.totalBytes > 0:
        current = _format_bytes(progress.downloadedBytes)
        total = _format_bytes(progress.totalBytes)
        if progress.totalFiles and progress.totalFiles > 0:
            return f"Downloading {model_name}: {current} / {total} ({progress.completedFiles}/{progress.totalFiles} files)"
        return f"Downloading {model_name}: {current} / {total}"

    if progress.totalFiles and progress.totalFiles > 0:
        return f"Downloading {model_name}: {progress.completedFiles}/{progress.totalFiles} files"

    if progress.phase == "downloading":
        return f"Downloading {model_name}"

    return f"Downloading {model_name}"


def _create_bootstrap_asset_progress(entries) -> list[BootstrapAssetDownloadProgress]:
    items: list[BootstrapAssetDownloadProgress] = []
    if os.name == "nt":
        items.append(
            BootstrapAssetDownloadProgress(
                modelKey="cuda_runtime",
                displayName="CUDA Runtime",
            )
        )
    items.extend(
        [
        BootstrapAssetDownloadProgress(
            modelKey=entry.modelKey,
            displayName=entry.displayName,
        )
        for entry in entries
        ]
    )
    return items


def _update_bootstrap_asset_progress(
    items: list[BootstrapAssetDownloadProgress],
    model_key: str,
    **updates,
) -> list[BootstrapAssetDownloadProgress]:
    return [
        item.model_copy(update=updates) if item.modelKey == model_key else item
        for item in items
    ]


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, TaskRecord] = {}
        self._lock = threading.Lock()
        self._bridge = VoxCPMBridge()
        self._asr_bridge = ASRBridge()
        self._work_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()

    def _worker_loop(self) -> None:
        while True:
            try:
                job = self._work_queue.get()
                job()
            except Exception:
                logger.exception("Worker loop caught unexpected error")
            finally:
                self._work_queue.task_done()

    def is_model_loaded(self) -> bool:
        return self._bridge.is_model_loaded()

    def is_asr_loaded(self) -> bool:
        return self._asr_bridge.is_model_loaded()

    def is_enhancer_loaded(self) -> bool:
        return self._bridge.is_enhancer_loaded()

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
        on_download_progress=None,
    ) -> ModelPrepareResponse:
        return self._bridge.prepare_model(
            model_key=model_key,
            provider_preference=provider_preference,
            ensure_downloaded=ensure_downloaded,
            on_download_progress=on_download_progress,
        )

    def create_generate_task(self, payload: GenerationRequest) -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        queue_depth = self._work_queue.qsize()
        voice_name = payload.voiceName.strip() if payload.voiceName and payload.voiceName.strip() else None
        task = TaskRecord(
            id=task_id,
            type="generate",
            status="queued",
            createdAt=now,
            updatedAt=now,
            title=self._task_title_from_text(payload.targetText),
            voiceName=voice_name,
            progress=0,
            message=f"Queued (position {queue_depth + 1})" if queue_depth > 0 else "Task queued",
        )
        with self._lock:
            self._tasks[task_id] = task

        self._work_queue.put(lambda tid=task_id, p=payload: self._run_generate_task(tid, p))
        return task

    def create_asr_task(self, audio_path: str, model_key: str = "sensevoice_small") -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        queue_depth = self._work_queue.qsize()
        task = TaskRecord(
            id=task_id,
            type="asr_transcribe",
            status="queued",
            createdAt=now,
            updatedAt=now,
            title=f"Transcribe {Path(audio_path).name}",
            progress=0,
            message=f"Queued (position {queue_depth + 1})" if queue_depth > 0 else "ASR task queued",
        )
        with self._lock:
            self._tasks[task_id] = task

        self._work_queue.put(lambda tid=task_id, ap=audio_path, mk=model_key: self._run_asr_task(tid, ap, mk))
        return task

    def create_bootstrap_bundle_task(self, provider_preference: str = "auto") -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        entries = bootstrap_entries()
        total_files = len(entries) + (1 if os.name == "nt" else 0)
        task = TaskRecord(
            id=task_id,
            type="bootstrap",
            status="queued",
            createdAt=now,
            updatedAt=now,
            title="Prepare speech tools bundle",
            progress=0,
            message="Preparing speech tools bundle",
            downloadProgress=DownloadProgress(
                phase="listing",
                downloadedBytes=0,
                totalBytes=None,
                totalBytesComplete=False,
                completedFiles=0,
                totalFiles=total_files,
            ),
            bootstrapAssetProgress=_create_bootstrap_asset_progress(entries),
        )
        with self._lock:
            self._tasks[task_id] = task

        self._work_queue.put(lambda tid=task_id, pp=provider_preference: self._run_bootstrap_bundle_task(tid, pp))
        return task

    def create_cuda_upgrade_task(self) -> TaskRecord:
        task_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        task = TaskRecord(
            id=task_id,
            type="cuda_upgrade",
            status="queued",
            createdAt=now,
            updatedAt=now,
            title="Prepare CUDA inference runtime",
            progress=0,
            message="Preparing CUDA inference runtime",
            downloadProgress=DownloadProgress(
                phase="listing",
                downloadedBytes=0,
                totalBytes=None,
                totalBytesComplete=False,
                completedFiles=0,
                totalFiles=2,
            ),
        )
        with self._lock:
            self._tasks[task_id] = task

        self._work_queue.put(lambda tid=task_id: self._run_cuda_upgrade_task(tid))
        return task

    def _run_cuda_upgrade_task(self, task_id: str) -> None:
        from app.services import cuda_upgrade

        if cuda_upgrade.has_runtime_complete_marker():
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="CUDA runtime already ready",
            )
            return

        def on_progress(event: dict) -> None:
            stage = event.get("stage")
            if stage == "download":
                downloaded = int(event.get("downloadedBytes") or 0)
                total = event.get("totalBytes")
                total_complete = bool(event.get("totalBytesComplete"))
                total_files = int(event.get("totalFiles") or 2)
                completed = int(event.get("completedFiles") or 0)
                current_file = event.get("currentFile")
                ratio = 0.0
                if total_complete and total and total > 0:
                    ratio = max(0.0, min(1.0, downloaded / total))
                progress = int(ratio * 85)
                self._update_task(
                    task_id,
                    status="running",
                    progress=progress,
                    message=current_file or "Downloading CUDA runtime",
                    download_progress=DownloadProgress(
                        phase="downloading",
                        downloadedBytes=downloaded,
                        totalBytes=total if total_complete else None,
                        totalBytesComplete=total_complete,
                        completedFiles=completed,
                        totalFiles=total_files,
                        currentFile=current_file,
                    ),
                )
            elif stage == "verifying":
                self._update_task(
                    task_id,
                    status="running",
                    progress=88,
                    message="Verifying CUDA runtime",
                )
            elif stage == "installing":
                self._update_task(
                    task_id,
                    status="running",
                    progress=94,
                    message="Installing CUDA runtime",
                )
            elif stage == "validating":
                self._update_task(
                    task_id,
                    status="running",
                    progress=98,
                    message="Validating CUDA runtime",
                )

        self._update_task(
            task_id,
            status="running",
            progress=1,
            message="Fetching PyTorch index",
        )

        try:
            result = cuda_upgrade.run_cuda_upgrade(progress=on_progress)
            from app.services.torch_runtime import purge_torch_modules

            purge_torch_modules()
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message=f"CUDA runtime ready (torch {result.self_check.get('torch_version')})",
            )
        except cuda_upgrade.UpgradeLockBusy as exc:
            self._update_task(
                task_id,
                status="failed",
                progress=0,
                message="Another CUDA upgrade is already running",
                error=AppError(
                    code="cuda_upgrade_busy",
                    userMessageKey="tasks.cuda.busy",
                    severity="error",
                    recoverable=True,
                    actions=["retry_later"],
                    message=str(exc),
                ),
            )
        except cuda_upgrade.CudaUpgradeError as exc:
            logger.exception("CUDA upgrade failed")
            self._update_task(
                task_id,
                status="failed",
                progress=0,
                message="CUDA upgrade failed",
                error=AppError(
                    code="cuda_upgrade_failed",
                    userMessageKey="tasks.cuda.failed",
                    severity="error",
                    recoverable=True,
                    actions=["retry"],
                    message=str(exc),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("CUDA upgrade failed unexpectedly")
            self._update_task(
                task_id,
                status="failed",
                progress=0,
                message="CUDA upgrade failed unexpectedly",
                error=AppError(
                    code="cuda_upgrade_unexpected",
                    userMessageKey="tasks.cuda.failed",
                    severity="error",
                    recoverable=True,
                    actions=["retry"],
                    message=str(exc),
                ),
            )

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

    def clear_cached_audio_tasks(self, output_dirs: list[Path]) -> list[str]:
        removed_task_ids: list[str] = []
        normalized_output_dirs = [directory.resolve() for directory in output_dirs]

        with self._lock:
            for task_id, task in list(self._tasks.items()):
                result = task.result
                if not result:
                    continue

                audio_candidates = [
                    result.audioPath,
                    result.rawAudioPath,
                    result.enhancedAudioPath,
                ]
                if not any(audio_candidates):
                    continue

                if any(
                    candidate and self._is_in_output_dirs(Path(candidate), normalized_output_dirs)
                    for candidate in audio_candidates
                ):
                    removed_task_ids.append(task_id)
                    self._tasks.pop(task_id, None)

        return removed_task_ids

    def _is_in_output_dirs(self, path: Path, output_dirs: list[Path]) -> bool:
        resolved_path = path.resolve()
        return any(directory == resolved_path or directory in resolved_path.parents for directory in output_dirs)

    def _run_generate_task(self, task_id: str, payload: GenerationRequest) -> None:
        self._update_task(task_id, status="running", progress=10, message="Resolving model source")
        try:
            self._update_task(task_id, status="running", progress=35, message="Loading VoxCPM model")
            (
                audio_path,
                sample_rate,
                duration_ms,
                model_key,
                provider,
                raw_audio_path,
                enhanced_audio_path,
                postprocess_message,
            ) = self._bridge.generate_audio(
                task_id=task_id,
                payload=payload,
            )
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message=postprocess_message or "Audio generated successfully",
                result=TaskResult(
                    audioPath=audio_path,
                    rawAudioPath=raw_audio_path,
                    enhancedAudioPath=enhanced_audio_path,
                    sampleRate=sample_rate,
                    durationMs=duration_ms,
                    modelKey=model_key,
                    modelPath=self._bridge._loaded_model_path,
                    provider=provider,
                ),
            )
        except Exception as exc:  # pragma: no cover - environment-specific runtime fallback
            logger.exception("Generation task %s failed", task_id)
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

    def _run_asr_task(self, task_id: str, audio_path: str, model_key: str) -> None:
        self._update_task(task_id, status="running", progress=10, message="Preparing SenseVoice model")
        try:
            prepared = self._bridge.prepare_model(
                model_key=model_key,
                provider_preference="modelscope",
                ensure_downloaded=False,
            )
            if not prepared.configExists:
                raise RuntimeError("SenseVoice assets are not ready. Please finish bootstrap first.")

            self._update_task(task_id, status="running", progress=45, message="Transcribing reference audio")
            transcript, transcript_language = self._asr_bridge.transcribe(
                audio_path=audio_path,
                model_path=prepared.modelPath,
            )
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="Reference audio transcribed",
                result=TaskResult(
                    transcript=transcript,
                    transcriptLanguage=transcript_language,
                    modelKey=model_key,
                    modelPath=prepared.modelPath,
                    provider=prepared.provider,
                ),
            )
        except Exception as exc:
            logger.exception("ASR task %s failed", task_id)
            self._update_task(
                task_id,
                status="failed",
                progress=100,
                message="Failed to transcribe audio",
                error=AppError(
                    code="ASR_RUNTIME_ERROR",
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
            type="bootstrap",
            status="queued",
            createdAt=now,
            updatedAt=now,
            title=f"Download {model_key}",
            progress=0,
            message=f"Preparing to download model {model_key}",
            downloadProgress=DownloadProgress(
                phase="listing",
                downloadedBytes=0,
                totalBytes=None,
                totalBytesComplete=False,
                completedFiles=0,
                totalFiles=None,
            ),
        )
        with self._lock:
            self._tasks[task_id] = task

        self._work_queue.put(lambda tid=task_id, mk=model_key, pp=provider_preference: self._run_download_task(tid, mk, pp))
        return task

    def _run_download_task(self, task_id: str, model_key: str, provider_preference: str) -> None:
        try:
            recommendation = self._bridge.get_provider_recommendation(provider_preference)
            provider = recommendation.current
            entry = get_model_entry(model_key)
            latest_download_progress = DownloadProgress(
                phase="listing",
                provider=provider,
                downloadedBytes=0,
                totalBytes=None,
                totalBytesComplete=False,
                completedFiles=0,
                totalFiles=None,
            )
            last_signature: tuple[object, ...] | None = None

            self._update_task(
                task_id,
                status="running",
                progress=0,
                message=_download_message(latest_download_progress, entry.displayName),
                download_progress=latest_download_progress,
            )

            def handle_download_progress(event: DownloadProgressEvent) -> None:
                nonlocal latest_download_progress, last_signature
                latest_download_progress = DownloadProgress(
                    phase=event.phase,
                    provider=event.provider,
                    currentFile=event.current_file,
                    downloadedBytes=event.downloaded_bytes,
                    totalBytes=event.total_bytes,
                    totalBytesComplete=event.total_bytes_complete,
                    completedFiles=event.completed_files,
                    totalFiles=event.total_files,
                )
                progress_value = _derive_download_progress(latest_download_progress)
                message = _download_message(latest_download_progress, entry.displayName)
                signature = (
                    latest_download_progress.phase,
                    latest_download_progress.provider,
                    latest_download_progress.currentFile,
                    latest_download_progress.downloadedBytes,
                    latest_download_progress.totalBytes,
                    latest_download_progress.totalBytesComplete,
                    latest_download_progress.completedFiles,
                    latest_download_progress.totalFiles,
                    progress_value,
                    message,
                )
                if signature == last_signature:
                    return
                last_signature = signature
                self._update_task(
                    task_id,
                    status="running",
                    progress=progress_value,
                    message=message,
                    download_progress=latest_download_progress,
                )

            result = self._bridge.prepare_model(
                model_key=model_key,
                provider_preference=provider_preference,
                ensure_downloaded=True,
                on_download_progress=handle_download_progress,
            )

            self._update_task(
                task_id,
                status="running",
                progress=99,
                message=_download_message(
                    DownloadProgress(
                        phase="finalizing",
                        provider=provider,
                        currentFile=latest_download_progress.currentFile,
                        downloadedBytes=latest_download_progress.downloadedBytes,
                        totalBytes=latest_download_progress.totalBytes,
                        totalBytesComplete=latest_download_progress.totalBytesComplete,
                        completedFiles=latest_download_progress.completedFiles,
                        totalFiles=latest_download_progress.totalFiles,
                    ),
                    entry.displayName,
                ),
                download_progress=DownloadProgress(
                    phase="finalizing",
                    provider=provider,
                    currentFile=latest_download_progress.currentFile,
                    downloadedBytes=latest_download_progress.downloadedBytes,
                    totalBytes=latest_download_progress.totalBytes,
                    totalBytesComplete=latest_download_progress.totalBytesComplete,
                    completedFiles=latest_download_progress.completedFiles,
                    totalFiles=latest_download_progress.totalFiles,
                ),
            )

            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message=f"{entry.displayName} is ready",
                download_progress=DownloadProgress(
                    phase="finalizing",
                    provider=provider,
                    currentFile=latest_download_progress.currentFile,
                    downloadedBytes=(
                        latest_download_progress.totalBytes
                        if latest_download_progress.totalBytesComplete and latest_download_progress.totalBytes
                        else latest_download_progress.downloadedBytes
                    ),
                    totalBytes=latest_download_progress.totalBytes,
                    totalBytesComplete=latest_download_progress.totalBytesComplete,
                    completedFiles=latest_download_progress.totalFiles or latest_download_progress.completedFiles,
                    totalFiles=latest_download_progress.totalFiles,
                ),
                result=TaskResult(
                    modelKey=model_key,
                    modelPath=result.modelPath,
                    provider=provider,
                ),
            )
        except Exception as exc:
            current_progress = 0
            current_message = "Failed to download model"
            download_progress = None
            with self._lock:
                existing_task = self._tasks.get(task_id)
                if existing_task is not None:
                    current_progress = existing_task.progress or 0
                    current_message = existing_task.message or current_message
                    download_progress = existing_task.downloadProgress
            self._update_task(
                task_id,
                status="failed",
                progress=current_progress,
                message=current_message,
                download_progress=download_progress,
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
        download_progress: DownloadProgress | None = None,
        bootstrap_asset_progress: list[BootstrapAssetDownloadProgress] | None = None,
        result: TaskResult | None = None,
        error: AppError | None = None,
    ) -> None:
        with self._lock:
            task = self._tasks[task_id]
            task.status = status
            task.progress = progress
            task.message = message
            task.updatedAt = datetime.now(UTC).isoformat()
            task.downloadProgress = download_progress
            task.bootstrapAssetProgress = bootstrap_asset_progress or []
            task.result = result
            task.error = error

    def _task_title_from_text(self, text: str) -> str:
        normalized = " ".join((text or "").split())
        if not normalized:
            return "Untitled task"
        return normalized[:80]

    def _run_bootstrap_bundle_task(self, task_id: str, provider_preference: str) -> None:
        entries = bootstrap_entries()
        completed_assets: list[str] = []
        requires_cuda_runtime = os.name == "nt"
        total_assets = len(entries) + (1 if requires_cuda_runtime else 0)
        latest_progress: DownloadProgress | None = None
        asset_progress = _create_bootstrap_asset_progress(entries)

        try:
            self._update_task(
                task_id,
                status="running",
                progress=0,
                message="Preparing speech tools bundle",
                download_progress=DownloadProgress(
                    phase="listing",
                    downloadedBytes=0,
                    totalBytes=None,
                    totalBytesComplete=False,
                    completedFiles=0,
                    totalFiles=total_assets,
                ),
                bootstrap_asset_progress=asset_progress,
            )

            completed_units = 0

            if requires_cuda_runtime:
                from app.services import cuda_upgrade

                if cuda_upgrade.has_runtime_complete_marker():
                    completed_assets.append("cuda_runtime")
                    completed_units += 1
                    latest_progress = DownloadProgress(
                        phase="finalizing",
                        provider="local",
                        currentFile="CUDA Runtime",
                        downloadedBytes=0,
                        totalBytes=None,
                        totalBytesComplete=True,
                        completedFiles=completed_units,
                        totalFiles=total_assets,
                    )
                    asset_progress = _update_bootstrap_asset_progress(
                        asset_progress,
                        "cuda_runtime",
                        status="succeeded",
                        progress=100,
                        provider="local",
                        currentFile="CUDA Runtime",
                        downloadedBytes=0,
                        totalBytes=None,
                        totalBytesComplete=True,
                    )
                    self._update_task(
                        task_id,
                        status="running",
                        progress=min(int((completed_units / max(total_assets, 1)) * 100), 99),
                        message="CUDA runtime is ready",
                        download_progress=latest_progress,
                        bootstrap_asset_progress=asset_progress,
                    )
                else:
                    def handle_cuda_progress(event: dict) -> None:
                        nonlocal asset_progress, latest_progress
                        stage = event.get("stage")
                        if stage == "download":
                            downloaded = int(event.get("downloadedBytes") or 0)
                            total = event.get("totalBytes")
                            total_complete = bool(event.get("totalBytesComplete"))
                            total_files = int(event.get("totalFiles") or 2)
                            completed = int(event.get("completedFiles") or 0)
                            current_file = event.get("currentFile") or "CUDA Runtime"
                            ratio = 0.0
                            if total_complete and total and total > 0:
                                ratio = max(0.0, min(1.0, downloaded / total))
                            visible_floor = 0
                            if downloaded > 0:
                                # Keep early progress visually responsive while the first large
                                # CUDA wheel is still far from 1% of its full size.
                                visible_floor = min(5, int(downloaded // (8 * 1024 * 1024)) + 1)
                            per_asset_progress = max(int(ratio * 85), visible_floor)
                            computed_overall_progress = min(
                                99,
                                int(((completed_units + (per_asset_progress / 100.0)) / max(total_assets, 1)) * 100),
                            )
                            overall_progress = max(computed_overall_progress, 1 if downloaded > 0 else 0)
                            latest_progress = DownloadProgress(
                                phase="downloading",
                                provider="local",
                                currentFile=current_file,
                                downloadedBytes=downloaded,
                                totalBytes=total if total_complete else None,
                                totalBytesComplete=total_complete,
                                completedFiles=completed_units,
                                totalFiles=total_assets,
                            )
                            asset_progress = _update_bootstrap_asset_progress(
                                asset_progress,
                                "cuda_runtime",
                                status="running",
                                progress=per_asset_progress,
                                provider="local",
                                currentFile=current_file,
                                downloadedBytes=downloaded,
                                totalBytes=total,
                                totalBytesComplete=total_complete,
                            )
                            self._update_task(
                                task_id,
                                status="running",
                                progress=overall_progress,
                                message=current_file,
                                download_progress=latest_progress,
                                bootstrap_asset_progress=asset_progress,
                            )
                            return

                        progress_map = {
                            "verifying": (88, "Verifying CUDA runtime"),
                            "installing": (94, "Installing CUDA runtime"),
                            "validating": (98, "Validating CUDA runtime"),
                        }
                        per_asset_progress, message = progress_map.get(
                            stage,
                            (1, "Preparing CUDA runtime"),
                        )
                        overall_progress = min(
                            99,
                            int(((completed_units + (per_asset_progress / 100.0)) / max(total_assets, 1)) * 100),
                        )
                        latest_progress = DownloadProgress(
                            phase="finalizing" if stage == "validating" else "listing",
                            provider="local",
                            currentFile="CUDA Runtime",
                            downloadedBytes=latest_progress.downloadedBytes if latest_progress else 0,
                            totalBytes=latest_progress.totalBytes if latest_progress else None,
                            totalBytesComplete=latest_progress.totalBytesComplete if latest_progress else False,
                            completedFiles=completed_units,
                            totalFiles=total_assets,
                        )
                        asset_progress = _update_bootstrap_asset_progress(
                            asset_progress,
                            "cuda_runtime",
                            status="running",
                            progress=per_asset_progress,
                            provider="local",
                            currentFile="CUDA Runtime",
                            downloadedBytes=latest_progress.downloadedBytes if latest_progress else 0,
                            totalBytes=latest_progress.totalBytes if latest_progress else None,
                            totalBytesComplete=latest_progress.totalBytesComplete if latest_progress else False,
                        )
                        self._update_task(
                            task_id,
                            status="running",
                            progress=overall_progress,
                            message=message,
                            download_progress=latest_progress,
                            bootstrap_asset_progress=asset_progress,
                        )

                    cuda_result = cuda_upgrade.run_cuda_upgrade(progress=handle_cuda_progress)
                    from app.services.torch_runtime import purge_torch_modules

                    purge_torch_modules()
                    completed_assets.append("cuda_runtime")
                    completed_units += 1
                    latest_progress = DownloadProgress(
                        phase="finalizing",
                        provider="local",
                        currentFile="CUDA Runtime",
                        downloadedBytes=latest_progress.downloadedBytes if latest_progress else 0,
                        totalBytes=latest_progress.totalBytes if latest_progress else None,
                        totalBytesComplete=latest_progress.totalBytesComplete if latest_progress else False,
                        completedFiles=completed_units,
                        totalFiles=total_assets,
                    )
                    asset_progress = _update_bootstrap_asset_progress(
                        asset_progress,
                        "cuda_runtime",
                        status="succeeded",
                        progress=100,
                        provider="local",
                        currentFile=f"CUDA Runtime ({cuda_result.self_check.get('torch_version', 'ready')})",
                        downloadedBytes=latest_progress.downloadedBytes,
                        totalBytes=latest_progress.totalBytes,
                        totalBytesComplete=True,
                    )
                    self._update_task(
                        task_id,
                        status="running",
                        progress=min(int((completed_units / max(total_assets, 1)) * 100), 99),
                        message="CUDA runtime is ready",
                        download_progress=latest_progress,
                        bootstrap_asset_progress=asset_progress,
                    )

            for index, entry in enumerate(entries):
                preferred_provider = provider_preference

                def handle_download_progress(event: DownloadProgressEvent, *, asset_index: int = index) -> None:
                    nonlocal asset_progress, latest_progress
                    current_asset_progress = DownloadProgress(
                        phase=event.phase,
                        provider=event.provider,
                        currentFile=event.current_file,
                        downloadedBytes=event.downloaded_bytes,
                        totalBytes=event.total_bytes,
                        totalBytesComplete=event.total_bytes_complete,
                        completedFiles=event.completed_files,
                        totalFiles=event.total_files,
                    )
                    per_asset_progress = _derive_download_progress(current_asset_progress)
                    overall_progress = min(
                        99,
                        int((((completed_units + asset_index) + (per_asset_progress / 100.0)) / max(total_assets, 1)) * 100),
                    )
                    latest_progress = DownloadProgress(
                        phase=event.phase,
                        provider=event.provider,
                        currentFile=event.current_file or entry.displayName,
                        downloadedBytes=event.downloaded_bytes,
                        totalBytes=event.total_bytes,
                        totalBytesComplete=event.total_bytes_complete,
                        completedFiles=completed_units + asset_index,
                        totalFiles=total_assets,
                    )
                    asset_progress = _update_bootstrap_asset_progress(
                        asset_progress,
                        entry.modelKey,
                        status="running",
                        progress=per_asset_progress,
                        provider=event.provider,
                        currentFile=event.current_file or entry.displayName,
                        downloadedBytes=event.downloaded_bytes,
                        totalBytes=event.total_bytes,
                        totalBytesComplete=event.total_bytes_complete,
                    )
                    self._update_task(
                        task_id,
                        status="running",
                        progress=overall_progress,
                        message=f"Preparing {entry.displayName}",
                        download_progress=latest_progress,
                        bootstrap_asset_progress=asset_progress,
                    )

                prepared = self._bridge.prepare_model(
                    model_key=entry.modelKey,
                    provider_preference=preferred_provider,
                    ensure_downloaded=True,
                    on_download_progress=handle_download_progress,
                )
                completed_assets.append(entry.modelKey)
                completed_units += 1
                latest_progress = DownloadProgress(
                    phase="finalizing",
                    provider=prepared.provider,
                    currentFile=entry.displayName,
                    downloadedBytes=latest_progress.downloadedBytes if latest_progress else 0,
                    totalBytes=latest_progress.totalBytes if latest_progress else None,
                    totalBytesComplete=latest_progress.totalBytesComplete if latest_progress else False,
                    completedFiles=completed_units,
                    totalFiles=total_assets,
                )
                asset_progress = _update_bootstrap_asset_progress(
                    asset_progress,
                    entry.modelKey,
                    status="succeeded",
                    progress=100,
                    provider=prepared.provider,
                    currentFile=entry.displayName,
                    downloadedBytes=latest_progress.totalBytes
                    if latest_progress and latest_progress.totalBytes is not None
                    else (latest_progress.downloadedBytes if latest_progress else 0),
                    totalBytes=latest_progress.totalBytes if latest_progress else None,
                    totalBytesComplete=True,
                )
                self._update_task(
                    task_id,
                    status="running",
                    progress=min(int((completed_units / max(total_assets, 1)) * 100), 99),
                    message=f"{entry.displayName} is ready",
                    download_progress=latest_progress,
                    bootstrap_asset_progress=asset_progress,
                )

            voxcpm_prepared = self._bridge.prepare_model(
                model_key=entries[0].modelKey,
                provider_preference=provider_preference,
                ensure_downloaded=False,
            )
            asset_progress = [
                item.model_copy(update={"status": "succeeded", "progress": 100})
                for item in asset_progress
            ]
            self._update_task(
                task_id,
                status="succeeded",
                progress=100,
                message="Speech tools bundle is ready",
                download_progress=DownloadProgress(
                    phase="finalizing",
                    provider=voxcpm_prepared.provider,
                    currentFile=entries[-1].displayName,
                    downloadedBytes=latest_progress.downloadedBytes if latest_progress else 0,
                    totalBytes=latest_progress.totalBytes if latest_progress else None,
                    totalBytesComplete=latest_progress.totalBytesComplete if latest_progress else False,
                    completedFiles=total_assets,
                    totalFiles=total_assets,
                ),
                bootstrap_asset_progress=asset_progress,
                result=TaskResult(
                    modelKey=voxcpm_prepared.modelKey,
                    modelPath=voxcpm_prepared.modelPath,
                    provider=voxcpm_prepared.provider,
                    completedAssets=completed_assets,
                ),
            )
        except Exception as exc:
            current_progress = 0
            current_message = "Failed to prepare speech tools bundle"
            current_asset_progress = asset_progress
            with self._lock:
                existing_task = self._tasks.get(task_id)
                if existing_task is not None:
                    current_progress = existing_task.progress or 0
                    current_message = existing_task.message or current_message
                    latest_progress = existing_task.downloadProgress
                    current_asset_progress = existing_task.bootstrapAssetProgress or current_asset_progress
            if len(completed_assets) < total_assets:
                if requires_cuda_runtime and "cuda_runtime" not in completed_assets:
                    failed_key = "cuda_runtime"
                    failed_display_name = "CUDA Runtime"
                else:
                    failed_index = max(0, len(completed_assets) - (1 if requires_cuda_runtime else 0))
                    failed_entry = entries[min(failed_index, max(len(entries) - 1, 0))]
                    failed_key = failed_entry.modelKey
                    failed_display_name = failed_entry.displayName
                failed_progress = next(
                    (
                        item.progress
                        for item in current_asset_progress
                        if item.modelKey == failed_key
                    ),
                    0,
                )
                current_asset_progress = _update_bootstrap_asset_progress(
                    current_asset_progress,
                    failed_key,
                    status="failed",
                    progress=max(failed_progress, 1),
                    currentFile=latest_progress.currentFile if latest_progress else failed_display_name,
                )
            self._update_task(
                task_id,
                status="failed",
                progress=current_progress,
                message=current_message,
                download_progress=latest_progress,
                bootstrap_asset_progress=current_asset_progress,
                error=AppError(
                    code="MODEL_DOWNLOAD_ERROR",
                    message=str(exc),
                    userMessageKey="error.model_download_error",
                    severity="error",
                    recoverable=True,
                    actions=["retry", "switch_download_source"],
                ),
            )
