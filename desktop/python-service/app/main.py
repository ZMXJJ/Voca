from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException

from app.models.schemas import (
    GenerationRequest,
    HealthResponse,
    ModelValidateRequest,
    ModelValidateResponse,
    TaskRecord,
)
from app.services.task_manager import TaskManager

app = FastAPI(title="Voca Python Service", version="0.1.0")
task_manager = TaskManager()


@app.get("/api/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        service="voca-python-service",
        status="ok",
        modelLoaded=False,
        asrLoaded=False,
        version="0.1.0",
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


@app.post("/api/v1/tasks/generate", response_model=TaskRecord)
def create_generate_task(payload: GenerationRequest) -> TaskRecord:
    return task_manager.create_generate_task(payload)


@app.get("/api/v1/tasks/{task_id}", response_model=TaskRecord)
def get_task(task_id: str) -> TaskRecord:
    task = task_manager.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task
