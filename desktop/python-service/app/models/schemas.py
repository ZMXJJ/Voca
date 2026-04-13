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
    deviceType: str | None = None
    audioOutputDir: str | None = None


class ModelValidateRequest(BaseModel):
    modelPath: str


class ProviderInfo(BaseModel):
    repoId: str | None = None
    modelId: str | None = None


class ModelCatalogEntry(BaseModel):
    modelKey: str
    displayName: str
    defaultProvider: Literal["huggingface", "modelscope"]
    localDir: str
    providers: dict[str, ProviderInfo]


class ProviderRecommendation(BaseModel):
    publicIp: str | None = None
    location: str | None = None
    preferred: Literal["auto", "huggingface", "modelscope"] = "auto"
    recommended: Literal["huggingface", "modelscope", "local"]
    current: Literal["huggingface", "modelscope", "local"]
    reason: Literal[
        "ip_region_cn",
        "ip_region_global",
        "manual_override",
        "fallback_after_failure",
        "provider_health",
        "default_fallback",
    ]
    userOverridden: bool = False


class ModelPrepareRequest(BaseModel):
    modelKey: str = "voxcpm2-default"
    providerPreference: Literal["auto", "huggingface", "modelscope"] = "auto"
    ensureDownloaded: bool = False


class ModelPrepareResponse(BaseModel):
    modelKey: str
    modelPath: str
    provider: Literal["huggingface", "modelscope", "local"]
    existsLocally: bool
    configExists: bool
    recommendation: ProviderRecommendation


class ModelValidateResponse(BaseModel):
    valid: bool
    architecture: str | None = None
    modelKey: str | None = None
    version: str | None = None
    error: AppError | None = None


class GenerationRequest(BaseModel):
    mode: Literal["quick_tts", "voice_design", "controllable_clone", "ultimate_clone"]
    targetText: str
    modelKey: str = "voxcpm2-default"
    providerPreference: Literal["auto", "huggingface", "modelscope"] = "auto"
    controlInstruction: str | None = None
    referenceAudioPath: str | None = None
    promptText: str | None = None
    cfgValue: float | None = 2.0
    inferenceTimesteps: int | None = 10
    normalize: bool | None = True
    denoise: bool | None = True
    streaming: bool | None = False
    seed: int | None = None


class ModelDownloadRequest(BaseModel):
    modelKey: str = "voxcpm2-default"
    providerPreference: Literal["auto", "huggingface", "modelscope"] = "auto"


class VoiceEntry(BaseModel):
    id: str
    name: str
    language: str
    durationSeconds: float | None = None
    audioPath: str | None = None
    isBuiltin: bool = False


class VoiceCreateRequest(BaseModel):
    name: str
    language: str = "zh"
    audioPath: str


class TaskResult(BaseModel):
    audioPath: str | None = None
    sampleRate: int | None = None
    durationMs: int | None = None
    modelKey: str | None = None
    modelPath: str | None = None
    provider: Literal["huggingface", "modelscope", "local"] | None = None


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
