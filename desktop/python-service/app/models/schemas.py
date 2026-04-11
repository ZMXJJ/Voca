from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class AppError(BaseModel):
    code: str
    message: str | None = None
    userMessageKey: str
    severity: Literal["info", "warning", "error", "blocking"]
    recoverable: bool = True
    actions: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    service: str
    status: Literal["ok"]
    modelLoaded: bool
    asrLoaded: bool
    version: str


class ModelValidateRequest(BaseModel):
    modelPath: str


class ModelValidateResponse(BaseModel):
    valid: bool
    architecture: str | None = None
    modelKey: str | None = None
    version: str | None = None
    error: AppError | None = None


class GenerationRequest(BaseModel):
    mode: Literal["quick_tts", "voice_design", "controllable_clone", "ultimate_clone"]
    targetText: str
    controlInstruction: str | None = None
    referenceAudioPath: str | None = None
    promptText: str | None = None
    cfgValue: float | None = 2.0
    inferenceTimesteps: int | None = 10
    normalize: bool | None = True
    denoise: bool | None = True
    streaming: bool | None = False


class TaskResult(BaseModel):
    audioPath: str | None = None
    sampleRate: int | None = None
    durationMs: int | None = None


class TaskRecord(BaseModel):
    id: str
    type: Literal["generate"]
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    createdAt: str
    updatedAt: str
    progress: int | None = None
    message: str | None = None
    result: TaskResult | None = None
    error: AppError | None = None
