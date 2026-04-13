from __future__ import annotations

import platform
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException

from app.models.schemas import (
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
)
from app.services.task_manager import TaskManager
from app.services import voice_library

app = FastAPI(title="Voca Python Service", version="0.1.0")
task_manager = TaskManager()


def _detect_device_type() -> str:
    try:
        import torch  # type: ignore
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return f"cuda ({torch.cuda.get_device_name(0)})"
    except Exception:
        pass
    if platform.machine() in ("arm64", "aarch64") and platform.system() == "Darwin":
        return "mps (Apple Silicon)"
    return "cpu"


@app.get("/api/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    audio_output_dir = str(Path(tempfile.gettempdir()) / "voca" / "outputs")
    return HealthResponse(
        service="voca-python-service",
        status="ok",
        modelLoaded=task_manager.is_model_loaded(),
        asrLoaded=False,
        version="0.1.0",
        deviceType=_detect_device_type(),
        audioOutputDir=audio_output_dir,
    )


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


@app.post("/api/v1/tasks/generate", response_model=TaskRecord)
def create_generate_task(payload: GenerationRequest) -> TaskRecord:
    return task_manager.create_generate_task(payload)


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
def clear_cache() -> dict[str, bool]:
    output_dir = Path(tempfile.gettempdir()) / "voca" / "outputs"
    cleared = 0
    if output_dir.exists():
        for f in output_dir.iterdir():
            if f.is_file():
                f.unlink()
                cleared += 1
    return {"success": True, "clearedFiles": cleared}


@app.get("/api/v1/voices", response_model=list[VoiceEntry])
def list_voices() -> list[VoiceEntry]:
    return voice_library.list_voices()


@app.post("/api/v1/voices", response_model=VoiceEntry, status_code=201)
def create_voice(payload: VoiceCreateRequest) -> VoiceEntry:
    try:
        return voice_library.create_voice(
            name=payload.name,
            language=payload.language,
            audio_path=payload.audioPath,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/v1/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> None:
    if not voice_library.delete_voice(voice_id):
        raise HTTPException(status_code=404, detail="voice not found")
