from __future__ import annotations

import platform
import subprocess
import uuid
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException

from app.models.schemas import (
    AudioTranscriptionRequest,
    GenerationRequest,
    HealthResponse,
    ModelCatalogEntry,
    ModelDownloadRequest,
    ModelPrepareRequest,
    ModelPrepareResponse,
    ModelValidateRequest,
    ModelValidateResponse,
    ProviderRecommendation,
    TaskRecord,
    VoiceCreateRequest,
    VoiceEntry,
    VoiceUpdateRequest,
)
from app.services.task_manager import TaskManager
from app.services import voice_library
from app.services.bootstrap_assets import (
    bootstrap_asset_statuses,
    bootstrap_entries,
    cleanup_legacy_sensevoice_pytorch,
    has_legacy_sensevoice_pytorch,
)
from app.services.download_pings import start_download_ping_dispatcher
from app.services.model_integrity import cleanup_orphans, verify_full
from app.services.storage_paths import (
    app_support_dir,
    audio_output_dir,
    huggingface_hub_cache_dir,
    legacy_audio_output_dirs,
    logs_dir,
    models_dir,
    modelscope_cache_dir,
    torch_cache_dir,
    voices_dir,
)

app = FastAPI(title="Voca Python Service", version="0.3.0")
task_manager = TaskManager()
SERVICE_LOG_LEVEL = "warning"
SERVICE_INSTANCE_ID = str(uuid.uuid4())
SERVICE_STARTED_AT = datetime.now(UTC).isoformat()


def _read_command_output(command: list[str]) -> str | None:
    try:
        output = subprocess.check_output(command, stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None
    return output or None


@lru_cache(maxsize=1)
def _detect_host_device_name() -> str | None:
    if platform.system() == "Darwin":
        brand = _read_command_output(["sysctl", "-n", "machdep.cpu.brand_string"])
        if brand:
            return brand

        profiler_output = _read_command_output(["system_profiler", "SPHardwareDataType"])
        if profiler_output:
            for raw_line in profiler_output.splitlines():
                line = raw_line.strip()
                if line.startswith("Chip:"):
                    return line.split(":", 1)[1].strip() or None
                if line.startswith("Processor Name:"):
                    return line.split(":", 1)[1].strip() or None

        if platform.machine() in ("arm64", "aarch64"):
            return "Apple Silicon"

    processor = platform.processor().strip() if platform.processor() else ""
    if processor:
        return processor

    machine = platform.machine().strip()
    return machine or None


def _detect_device_info() -> tuple[str, str | None]:
    try:
        import torch  # type: ignore

        if torch.backends.mps.is_available():
            return "mps", _detect_host_device_name()
        if torch.cuda.is_available():
            return "cuda", torch.cuda.get_device_name(0)
    except Exception:
        pass

    return "cpu", _detect_host_device_name()


def _storage_dir() -> Path:
    path = app_support_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _logs_dir() -> Path:
    path = logs_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _audio_output_dir() -> Path:
    return audio_output_dir()


def _safe_file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _directory_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0

    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += _safe_file_size(item)
    return total


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _build_health_response() -> HealthResponse:
    storage_dir = _storage_dir()
    log_dir = _logs_dir()
    output_dir = _audio_output_dir()
    model_dir = models_dir()
    voice_dir = voices_dir()
    hf_cache_dir = huggingface_hub_cache_dir()
    ms_cache_dir = modelscope_cache_dir()
    torch_dir = torch_cache_dir()
    asset_statuses = bootstrap_asset_statuses()
    asset_ready_map = {item.modelKey: item.ready for item in asset_statuses}

    cache_bytes = _directory_size_bytes(output_dir)
    model_bytes = _directory_size_bytes(model_dir)
    voice_library_bytes = _directory_size_bytes(voice_dir)
    log_bytes = _directory_size_bytes(log_dir)
    huggingface_cache_bytes = _directory_size_bytes(hf_cache_dir)
    modelscope_cache_bytes = _directory_size_bytes(ms_cache_dir)
    torch_cache_bytes = _directory_size_bytes(torch_dir)
    managed_storage_bytes = _directory_size_bytes(storage_dir) + cache_bytes

    for extra_dir, extra_bytes in (
        (model_dir, model_bytes),
        (output_dir, cache_bytes),
    ):
        if extra_bytes <= 0 or _is_within(extra_dir, storage_dir):
            continue
        managed_storage_bytes += extra_bytes

    device_type, device_name = _detect_device_info()
    return HealthResponse(
        service="voca-python-service",
        status="ok",
        instanceId=SERVICE_INSTANCE_ID,
        startedAt=SERVICE_STARTED_AT,
        modelLoaded=task_manager.is_model_loaded(),
        asrLoaded=task_manager.is_asr_loaded(),
        coreModelReady=asset_ready_map.get("voxcpm2", False),
        asrModelReady=asset_ready_map.get("sensevoice_small", False),
        zipEnhancerReady=asset_ready_map.get("zipenhancer_16k", False),
        speechToolsReady=all(asset_ready_map.get(key, False) for key in ("sensevoice_small", "zipenhancer_16k")),
        bootstrapAssetsReady=all(item.ready for item in asset_statuses),
        version="0.3.0",
        deviceName=device_name,
        deviceType=device_type,
        audioOutputDir=str(output_dir),
        cacheBytes=cache_bytes,
        logLevel=SERVICE_LOG_LEVEL,
        logDir=str(log_dir),
        logBytes=log_bytes,
        storageDir=str(storage_dir),
        modelDir=str(model_dir),
        modelBytes=model_bytes,
        voicesDir=str(voice_dir),
        voiceLibraryBytes=voice_library_bytes,
        huggingfaceCacheDir=str(hf_cache_dir),
        huggingfaceCacheBytes=huggingface_cache_bytes,
        modelscopeCacheDir=str(ms_cache_dir),
        modelscopeCacheBytes=modelscope_cache_bytes,
        torchCacheDir=str(torch_dir),
        torchCacheBytes=torch_cache_bytes,
        downloadCacheBytes=huggingface_cache_bytes + modelscope_cache_bytes + torch_cache_bytes,
        managedStorageBytes=managed_storage_bytes,
        bootstrapAssets=asset_statuses,
        legacyAsrModelPresent=has_legacy_sensevoice_pytorch(),
    )


def _clear_directory_files(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0

    cleared_files = 0
    cleared_bytes = 0
    for item in sorted(path.rglob("*"), reverse=True):
        if item.is_file():
            cleared_bytes += _safe_file_size(item)
            item.unlink(missing_ok=True)
            cleared_files += 1
            continue

        if item.is_dir():
            try:
                item.rmdir()
            except OSError:
                pass

    return cleared_files, cleared_bytes


@app.on_event("startup")
def _on_startup_cleanup() -> None:
    try:
        cleanup_orphans()
    except Exception:  # pragma: no cover - best-effort housekeeping
        pass
    try:
        start_download_ping_dispatcher()
    except Exception:  # pragma: no cover - download pings must never break boot
        pass


@app.get("/api/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return _build_health_response()


@app.post("/api/v1/bootstrap/verify")
def verify_bootstrap_assets() -> dict[str, object]:
    results: list[dict[str, object]] = []
    for entry in bootstrap_entries():
        outcome = verify_full(Path(entry.localDir))
        results.append(
            {
                "modelKey": entry.modelKey,
                "displayName": entry.displayName,
                "localDir": entry.localDir,
                "ok": outcome.ok,
                "reason": outcome.reason,
            }
        )
    return {
        "allOk": all(bool(item["ok"]) for item in results),
        "results": results,
    }


@app.get("/api/v1/models/catalog", response_model=list[ModelCatalogEntry])
def list_models() -> list[ModelCatalogEntry]:
    return task_manager.list_models()


@app.get("/api/v1/providers/recommendation", response_model=ProviderRecommendation)
def get_provider_recommendation(
    preferred: Literal["auto", "huggingface", "modelscope"] = "auto",
) -> ProviderRecommendation:
    return task_manager.get_provider_recommendation(preferred)


@app.post("/api/v1/models/prepare", response_model=ModelPrepareResponse)
def prepare_model(payload: ModelPrepareRequest) -> ModelPrepareResponse:
    return task_manager.prepare_model(
        model_key=payload.modelKey,
        provider_preference=payload.providerPreference,
        ensure_downloaded=payload.ensureDownloaded,
    )


@app.post("/api/v1/models/validate", response_model=ModelValidateResponse)
def validate_model(payload: ModelValidateRequest) -> ModelValidateResponse:
    model_path = Path(payload.modelPath)
    config_path = model_path / "config.json"

    if not model_path.exists():
        return ModelValidateResponse(valid=False)

    if not config_path.exists():
        return ModelValidateResponse(valid=False)

    return ModelValidateResponse(
        valid=True,
        architecture="voxcpm2",
        modelKey=model_path.name,
        version="unknown",
    )


@app.post("/api/v1/models/download", response_model=TaskRecord)
def create_download_task(payload: ModelDownloadRequest) -> TaskRecord:
    return task_manager.create_download_task(
        model_key=payload.modelKey,
        provider_preference=payload.providerPreference,
    )


@app.post("/api/v1/bootstrap/start", response_model=TaskRecord)
def create_bootstrap_bundle_task(payload: ModelDownloadRequest) -> TaskRecord:
    return task_manager.create_bootstrap_bundle_task(
        provider_preference=payload.providerPreference,
    )


@app.post("/api/v1/bootstrap/cleanup-legacy-asr")
def cleanup_legacy_asr_model() -> dict[str, bool]:
    """Remove the pre-ONNX FunASR SenseVoice directory if present.

    The new ONNX runtime installs to ``models/sensevoice_small_onnx/`` while
    legacy builds wrote to ``models/sensevoice_small/``. Any leftover legacy
    directory is dead weight (~936 MB) and incompatible with the new bridge;
    this endpoint quarantines it into ``models/.trash/`` for background
    rmtree.
    """
    removed = cleanup_legacy_sensevoice_pytorch()
    return {"removed": removed}


@app.post("/api/v1/tasks/generate", response_model=TaskRecord)
def create_generate_task(payload: GenerationRequest) -> TaskRecord:
    return task_manager.create_generate_task(payload)


@app.post("/api/v1/tasks/asr", response_model=TaskRecord)
def create_asr_task(payload: AudioTranscriptionRequest) -> TaskRecord:
    return task_manager.create_asr_task(
        audio_path=payload.audioPath,
        model_key=payload.modelKey,
    )


@app.get("/api/v1/tasks", response_model=list[TaskRecord])
def list_tasks(
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
) -> list[TaskRecord]:
    return task_manager.list_tasks(limit=limit, offset=offset, status=status)


@app.get("/api/v1/tasks/{task_id}", response_model=TaskRecord)
def get_task(task_id: str) -> TaskRecord:
    task = task_manager.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@app.post("/api/v1/cache/clear")
def clear_cache() -> dict[str, object]:
    output_dirs = legacy_audio_output_dirs()
    removed_task_ids = task_manager.clear_cached_audio_tasks(output_dirs)
    cleared_files = 0
    cleared_bytes = 0
    for output_dir in output_dirs:
        next_cleared_files, next_cleared_bytes = _clear_directory_files(output_dir)
        cleared_files += next_cleared_files
        cleared_bytes += next_cleared_bytes
    service_info = _build_health_response()
    return {
        "success": True,
        "clearedFiles": cleared_files,
        "clearedBytes": cleared_bytes,
        "remainingBytes": sum(_directory_size_bytes(output_dir) for output_dir in output_dirs),
        "removedTasks": len(removed_task_ids),
        "removedTaskIds": removed_task_ids,
        "clearedAudioDirs": [str(path) for path in output_dirs],
        "serviceInfo": service_info.model_dump(mode="json"),
    }


@app.get("/api/v1/voices", response_model=list[VoiceEntry])
def list_voices() -> list[VoiceEntry]:
    return voice_library.list_voices()


@app.get("/api/v1/voices/{voice_id}", response_model=VoiceEntry)
def get_voice(voice_id: str) -> VoiceEntry:
    voice = voice_library.get_voice(voice_id)
    if voice is None:
        raise HTTPException(status_code=404, detail="voice not found")
    return voice


@app.post("/api/v1/voices", response_model=VoiceEntry, status_code=201)
def create_voice(payload: VoiceCreateRequest) -> VoiceEntry:
    try:
        return voice_library.create_voice(
            name=payload.name,
            language=payload.language,
            description=payload.description,
            reference_audio_path=payload.referenceAudioPath,
            reference_transcript=payload.referenceTranscript,
            transcript_language=payload.transcriptLanguage,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/v1/voices/{voice_id}", response_model=VoiceEntry)
def update_voice(voice_id: str, payload: VoiceUpdateRequest) -> VoiceEntry:
    try:
        voice = voice_library.update_voice(
            voice_id,
            name=payload.name,
            language=payload.language,
            description=payload.description,
            reference_transcript=payload.referenceTranscript,
            transcript_language=payload.transcriptLanguage,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if voice is None:
        raise HTTPException(status_code=404, detail="voice not found")
    return voice


@app.delete("/api/v1/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> None:
    try:
        deleted = voice_library.delete_voice(voice_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if not deleted:
        raise HTTPException(status_code=404, detail="voice not found")
