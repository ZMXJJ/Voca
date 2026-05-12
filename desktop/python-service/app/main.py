from __future__ import annotations

import os
import platform
import subprocess
import threading
import time
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
    StorageInfoResponse,
    TaskRecord,
    VoiceCreateRequest,
    VoiceEntry,
    VoiceUpdateRequest,
)
from app.services.task_manager import CudaUpgradeUnsupported, TaskManager
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
from app.services.torch_runtime import import_torch_clean, purge_torch_modules

app = FastAPI(title="Voca Python Service", version="0.5.0")
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
    system = platform.system()
    if system == "Darwin":
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

    if system == "Windows":
        wmic_output = _read_command_output(["wmic", "cpu", "get", "Name", "/FORMAT:LIST"])
        if wmic_output:
            for raw_line in wmic_output.splitlines():
                line = raw_line.strip()
                if line.startswith("Name="):
                    value = line.split("=", 1)[1].strip()
                    if value:
                        return value

        powershell_output = _read_command_output([
            "powershell",
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Processor).Name",
        ])
        if powershell_output:
            return powershell_output

        identifier = os.environ.get("PROCESSOR_IDENTIFIER", "").strip()
        if identifier:
            return identifier

    processor = platform.processor().strip() if platform.processor() else ""
    if processor:
        return processor

    machine = platform.machine().strip()
    return machine or None


def _windows_cuda_runtime_ready() -> bool:
    """Return True only if the bundled Windows CUDA runtime overlay is installed.

    The Windows installer ships without torch/torchaudio; both are downloaded
    into ``runtime/site-packages/`` during first-run bootstrap. Importing torch
    before that overlay exists is guaranteed to fail, and even an attempted
    import locks the partially-populated ``.pyd`` / ``.dll`` files in the
    runtime directory for the lifetime of the sidecar — which then prevents
    the bootstrap installer from atomically replacing them. Defer the import
    until the CUDA runtime is fully ready.
    """

    try:
        from app.services.cuda_upgrade import has_runtime_complete_marker
    except Exception:
        return False
    try:
        return bool(has_runtime_complete_marker())
    except Exception:
        return False


def _detect_device_info() -> tuple[str, str | None]:
    if os.name == "nt" and not _windows_cuda_runtime_ready():
        return "cpu", _detect_host_device_name()

    try:
        torch = import_torch_clean()

        if torch.backends.mps.is_available():
            return "mps", _detect_host_device_name()
        if torch.cuda.is_available():
            return "cuda", torch.cuda.get_device_name(0)
    except Exception:
        purge_torch_modules()

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


# ---------------------------------------------------------------------------
# Directory-size cache
#
# Recursively walking the model + huggingface + modelscope + torch + logs +
# voices + outputs directories on Windows + NTFS + Defender easily takes
# seconds. After the lazy-storage refactor this only happens behind
# ``GET /api/v1/storage-info`` (which the desktop UI now calls only when the
# user opens the storage details modal), but a short TTL keeps repeated
# clicks within the same window cheap.
# ---------------------------------------------------------------------------

_DIRECTORY_SIZE_TTL_SECONDS = 30.0
_directory_size_cache: dict[str, tuple[int, float]] = {}
_directory_size_cache_lock = threading.Lock()


def _directory_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0

    cache_key = str(path)
    now = time.monotonic()
    with _directory_size_cache_lock:
        cached = _directory_size_cache.get(cache_key)
        if cached is not None and now - cached[1] < _DIRECTORY_SIZE_TTL_SECONDS:
            return cached[0]

    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += _safe_file_size(item)

    with _directory_size_cache_lock:
        _directory_size_cache[cache_key] = (total, now)
    return total


def _invalidate_directory_size_cache() -> None:
    """Drop all cached directory sizes.

    Call after operations that materially change disk usage (cache clear,
    bootstrap downloads completing, voice library mutations) so the next
    storage-info response returns a fresh value instead of a stale cache.
    """

    with _directory_size_cache_lock:
        _directory_size_cache.clear()


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _build_health_response() -> HealthResponse:
    """Lightweight readiness response — never walks the filesystem.

    Storage byte counters in this payload are intentionally fixed at ``0``;
    the desktop UI fetches actual sizes lazily via
    ``GET /api/v1/storage-info`` only when the storage details modal is
    opened. This keeps the health route a true probe (called by the Tauri
    sidecar supervisor on every command) instead of a multi-second IO storm.
    """

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
        version="0.5.0",
        deviceName=device_name,
        deviceType=device_type,
        audioOutputDir=str(output_dir),
        # All ``*Bytes`` are deliberately left at their default ``0`` here.
        # Real values come from ``StorageInfoResponse``.
        logLevel=SERVICE_LOG_LEVEL,
        logDir=str(log_dir),
        storageDir=str(storage_dir),
        modelDir=str(model_dir),
        voicesDir=str(voice_dir),
        huggingfaceCacheDir=str(hf_cache_dir),
        modelscopeCacheDir=str(ms_cache_dir),
        torchCacheDir=str(torch_dir),
        bootstrapAssets=asset_statuses,
        legacyAsrModelPresent=has_legacy_sensevoice_pytorch(),
    )


def _build_storage_info_response() -> StorageInfoResponse:
    """Compute on-disk usage for every managed directory.

    This is the only routine left in the service that does the recursive
    ``rglob + stat`` walk; it sits behind ``GET /api/v1/storage-info`` and
    is gated by the desktop UI to fire only when the user opens the storage
    details modal. Results are still memoised by ``_directory_size_bytes``
    for ``_DIRECTORY_SIZE_TTL_SECONDS`` so rapid re-opens stay cheap.
    """

    storage_dir = _storage_dir()
    log_dir = _logs_dir()
    output_dir = _audio_output_dir()
    model_dir = models_dir()
    voice_dir = voices_dir()
    hf_cache_dir = huggingface_hub_cache_dir()
    ms_cache_dir = modelscope_cache_dir()
    torch_dir = torch_cache_dir()

    cache_bytes = _directory_size_bytes(output_dir)
    model_bytes = _directory_size_bytes(model_dir)
    voice_library_bytes = _directory_size_bytes(voice_dir)
    log_bytes = _directory_size_bytes(log_dir)
    huggingface_cache_bytes = _directory_size_bytes(hf_cache_dir)
    modelscope_cache_bytes = _directory_size_bytes(ms_cache_dir)
    torch_cache_bytes = _directory_size_bytes(torch_dir)

    # Sum the components instead of recursing over ``storage_dir`` again.
    # ``model_dir`` and ``output_dir`` may live outside ``storage_dir`` in
    # custom configurations, but in either case we only want to count them
    # once (their bytes are already fully captured above).
    managed_storage_bytes = (
        log_bytes
        + voice_library_bytes
        + huggingface_cache_bytes
        + modelscope_cache_bytes
        + torch_cache_bytes
        + model_bytes
        + cache_bytes
    )
    # Touch ``_is_within``/``storage_dir`` only to keep the historical
    # invariant that the umbrella value is at least as large as its parts;
    # no extra disk walk happens here.
    _ = _is_within(model_dir, storage_dir)

    return StorageInfoResponse(
        audioOutputDir=str(output_dir),
        cacheBytes=cache_bytes,
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


@app.get("/api/v1/storage-info", response_model=StorageInfoResponse)
def storage_info() -> StorageInfoResponse:
    return _build_storage_info_response()


@app.get("/api/v1/probe")
def probe() -> dict[str, str]:
    return {
        "service": "voca-python-service",
        "status": "ok",
        "instanceId": SERVICE_INSTANCE_ID,
    }


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
    if removed:
        _invalidate_directory_size_cache()
    return {"removed": removed}


@app.post("/api/v1/bootstrap/upgrade-cuda", response_model=TaskRecord)
def create_cuda_upgrade_task() -> TaskRecord:
    try:
        return task_manager.create_cuda_upgrade_task()
    except CudaUpgradeUnsupported as exc:
        # Translate to a typed HTTP 400 so cross-platform clients (macOS/Linux
        # builds merged from main) can branch on the structured error code
        # rather than parsing a generic 500 message.
        raise HTTPException(
            status_code=400,
            detail={
                "code": "cuda_upgrade_unsupported_platform",
                "message": str(exc),
            },
        ) from exc


@app.get("/api/v1/bootstrap/runtime-info")
def bootstrap_runtime_info() -> dict[str, object]:
    from app.services import cuda_upgrade

    data = cuda_upgrade.read_runtime_json()
    return {
        "active": data.get("active"),
        "lastKnownGoodBackend": data.get("lastKnownGoodBackend"),
        "lastUpgradeAt": data.get("lastUpgradeAt"),
        "lastUpgradeError": data.get("lastUpgradeError"),
    }


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
    # Sizes on disk just changed materially; force the next storage-info
    # response to re-scan instead of returning the (now stale) cached numbers.
    _invalidate_directory_size_cache()
    storage_info_payload = _build_storage_info_response()
    return {
        "success": True,
        "clearedFiles": cleared_files,
        "clearedBytes": cleared_bytes,
        "remainingBytes": sum(_directory_size_bytes(output_dir) for output_dir in output_dirs),
        "removedTasks": len(removed_task_ids),
        "removedTaskIds": removed_task_ids,
        "clearedAudioDirs": [str(path) for path in output_dirs],
        "storageInfo": storage_info_payload.model_dump(mode="json"),
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
