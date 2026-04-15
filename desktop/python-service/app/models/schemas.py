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
    instanceId: str | None = None
    startedAt: str | None = None
    modelLoaded: bool
    asrLoaded: bool
    coreModelReady: bool = False
    asrModelReady: bool = False
    zipEnhancerReady: bool = False
    speechToolsReady: bool = False
    bootstrapAssetsReady: bool = False
    version: str
    deviceName: str | None = None
    deviceType: str | None = None
    audioOutputDir: str | None = None
    cacheBytes: int = 0
    logLevel: str | None = None
    logDir: str | None = None
    logBytes: int = 0
    storageDir: str | None = None
    modelDir: str | None = None
    modelBytes: int = 0
    voicesDir: str | None = None
    voiceLibraryBytes: int = 0
    huggingfaceCacheDir: str | None = None
    huggingfaceCacheBytes: int = 0
    modelscopeCacheDir: str | None = None
    modelscopeCacheBytes: int = 0
    torchCacheDir: str | None = None
    torchCacheBytes: int = 0
    downloadCacheBytes: int = 0
    managedStorageBytes: int = 0
    bootstrapAssets: list["BootstrapAssetStatus"] = Field(default_factory=list)


class BootstrapAssetStatus(BaseModel):
    modelKey: str
    displayName: str
    assetRole: Literal["tts", "asr", "enhancer"] = "tts"
    ready: bool = False
    bootstrapRequired: bool = False
    localDir: str
    approxSizeLabel: str | None = None


class ModelValidateRequest(BaseModel):
    modelPath: str


class ProviderInfo(BaseModel):
    repoId: str | None = None
    modelId: str | None = None


class ModelCatalogEntry(BaseModel):
    modelKey: str
    displayName: str
    description: str | None = None
    defaultProvider: Literal["huggingface", "modelscope"]
    localDir: str
    assetRole: Literal["tts", "asr", "enhancer"] = "tts"
    bootstrapRequired: bool = False
    approxSizeLabel: str | None = None
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
    modelKey: str = "voxcpm2"
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
    modelKey: str = "voxcpm2"
    providerPreference: Literal["auto", "huggingface", "modelscope"] = "auto"
    controlInstruction: str | None = None
    referenceAudioPath: str | None = None
    promptText: str | None = None
    cfgValue: float | None = 2.0
    inferenceTimesteps: int | None = 10
    normalize: bool | None = True
    denoise: bool | None = False
    streaming: bool | None = False
    seed: int | None = None


class ModelDownloadRequest(BaseModel):
    modelKey: str = "voxcpm2"
    providerPreference: Literal["auto", "huggingface", "modelscope"] = "auto"


class VoiceEntry(BaseModel):
    id: str
    name: str
    language: str
    description: str
    durationSeconds: float | None = None
    referenceAudioPath: str | None = None
    referenceTranscript: str | None = None
    transcriptLanguage: str | None = None
    sourceType: Literal["builtin", "user"] = "user"
    canRename: bool = False
    canDelete: bool = False
    presetKey: str | None = None
    createdAt: str
    updatedAt: str


class VoiceCreateRequest(BaseModel):
    name: str
    language: str = "zh"
    description: str
    referenceAudioPath: str | None = None
    referenceTranscript: str | None = None
    transcriptLanguage: str | None = None


class VoiceUpdateRequest(BaseModel):
    name: str | None = None
    language: str | None = None
    description: str | None = None
    referenceTranscript: str | None = None
    transcriptLanguage: str | None = None


class AudioTranscriptionRequest(BaseModel):
    audioPath: str
    modelKey: str = "sensevoice_small"


class DownloadProgress(BaseModel):
    phase: Literal["listing", "downloading", "finalizing"] = "listing"
    provider: Literal["huggingface", "modelscope", "local"] | None = None
    currentFile: str | None = None
    downloadedBytes: int = 0
    totalBytes: int | None = None
    totalBytesComplete: bool = False
    completedFiles: int = 0
    totalFiles: int | None = None


class BootstrapAssetDownloadProgress(BaseModel):
    modelKey: str
    displayName: str
    status: Literal["pending", "running", "succeeded", "failed"] = "pending"
    progress: int = 0
    provider: Literal["huggingface", "modelscope", "local"] | None = None
    currentFile: str | None = None
    downloadedBytes: int = 0
    totalBytes: int | None = None
    totalBytesComplete: bool = False


class TaskResult(BaseModel):
    audioPath: str | None = None
    rawAudioPath: str | None = None
    enhancedAudioPath: str | None = None
    sampleRate: int | None = None
    durationMs: int | None = None
    transcript: str | None = None
    transcriptLanguage: str | None = None
    modelKey: str | None = None
    modelPath: str | None = None
    provider: Literal["huggingface", "modelscope", "local"] | None = None
    completedAssets: list[str] = Field(default_factory=list)


class TaskRecord(BaseModel):
    id: str
    type: Literal["bootstrap", "generate", "asr_transcribe"]
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    createdAt: str
    updatedAt: str
    title: str | None = None
    progress: int | None = None
    message: str | None = None
    downloadProgress: DownloadProgress | None = None
    bootstrapAssetProgress: list[BootstrapAssetDownloadProgress] = Field(default_factory=list)
    result: TaskResult | None = None
    error: AppError | None = None
