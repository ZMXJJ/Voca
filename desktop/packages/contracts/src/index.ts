export type BootstrapPhase =
  | "welcome"
  | "env_check"
  | "runtime_download"
  | "model_download"
  | "asset_verify"
  | "warmup"
  | "ready"
  | "failed";

export type BootstrapState = {
  isFirstLaunch: boolean;
  phase: BootstrapPhase;
  status: "idle" | "running" | "paused" | "failed" | "ready";
  runtimeReady: boolean;
  modelReady: boolean;
  sidecarReady: boolean;
  currentDownloadJobId?: string | null;
  lastError?: AppError | null;
  needsRepair?: boolean;
};

export type ErrorSeverity = "info" | "warning" | "error" | "blocking";

export type ErrorAction =
  | "retry"
  | "resume"
  | "switch_download_source"
  | "open_settings"
  | "reinitialize"
  | "export_logs"
  | "check_disk"
  | "contact_support";

export type AppError = {
  code: string;
  message?: string;
  userMessageKey: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  actions: ErrorAction[];
  details?: Record<string, unknown>;
};

export type TaskType =
  | "bootstrap"
  | "generate"
  | "clone"
  | "asr_transcribe"
  | "cuda_upgrade";

export type CudaUpgradeStage = "download" | "verify" | "install" | "validate";

export type CudaUpgradeRuntimeInfo = {
  active?: TorchBackend | string | null;
  lastKnownGoodBackend?: TorchBackend | string | null;
  lastUpgradeAt?: string | null;
  lastUpgradeError?: string | null;
};

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DownloadProgress = {
  phase: "listing" | "downloading" | "finalizing";
  provider?: ModelProvider | null;
  currentFile?: string | null;
  downloadedBytes: number;
  totalBytes?: number | null;
  totalBytesComplete: boolean;
  completedFiles: number;
  totalFiles?: number | null;
};

export type BootstrapAssetDownloadProgress = {
  modelKey: string;
  displayName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  progress: number;
  provider?: ModelProvider | null;
  currentFile?: string | null;
  downloadedBytes: number;
  totalBytes?: number | null;
  totalBytesComplete: boolean;
};

export type TaskRecord = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  title?: string;
  voiceName?: string;
  progress?: number;
  message?: string;
  downloadProgress?: DownloadProgress | null;
  bootstrapAssetProgress?: BootstrapAssetDownloadProgress[] | null;
  error?: AppError | null;
  result?: {
    audioPath?: string;
    rawAudioPath?: string;
    enhancedAudioPath?: string;
    sampleRate?: number;
    durationMs?: number;
    transcript?: string;
    transcriptLanguage?: string;
    modelKey?: string;
    modelPath?: string;
    provider?: ModelProvider;
    completedAssets?: string[];
  } | null;
};

export type GenerationMode =
  | "quick_tts"
  | "voice_design"
  | "controllable_clone"
  | "ultimate_clone";

export type ModelProvider = "huggingface" | "modelscope" | "local";

export type ModelAssetRole = "tts" | "asr" | "enhancer";

export type ProviderPreference = "auto" | "huggingface" | "modelscope";

export type ProviderRecommendationReason =
  | "ip_region_cn"
  | "ip_region_global"
  | "manual_override"
  | "fallback_after_failure"
  | "provider_health"
  | "default_fallback";

export type ProviderRecommendation = {
  publicIp?: string | null;
  location?: string | null;
  preferred: ProviderPreference;
  recommended: ModelProvider;
  current: ModelProvider;
  reason: ProviderRecommendationReason;
  userOverridden: boolean;
};

export type ModelCatalogEntry = {
  modelKey: string;
  displayName: string;
  description?: string;
  descriptionKey?: string;
  tags?: string[];
  defaultProvider: Exclude<ModelProvider, "local">;
  localDir: string;
  assetRole: ModelAssetRole;
  bootstrapRequired: boolean;
  approxSizeLabel?: string;
  providers: {
    huggingface?: {
      repoId: string;
    };
    modelscope?: {
      modelId: string;
    };
  };
};

export type BootstrapAssetStatus = {
  modelKey: string;
  displayName: string;
  assetRole: ModelAssetRole;
  ready: boolean;
  bootstrapRequired: boolean;
  localDir: string;
  approxSizeLabel?: string | null;
};

export type ModelPrepareResponse = {
  modelKey: string;
  modelPath: string;
  provider: ModelProvider;
  existsLocally: boolean;
  configExists: boolean;
  recommendation: ProviderRecommendation;
};

export type GenerationParams = {
  mode: GenerationMode;
  targetText: string;
  modelKey?: string;
  providerPreference?: ProviderPreference;
  voiceName?: string;
  controlInstruction?: string;
  referenceAudioPath?: string;
  promptText?: string;
  extremeClone?: boolean;
  cfgValue?: number;
  inferenceTimesteps?: number;
  normalize?: boolean;
  denoise?: boolean;
  streaming?: boolean;
  seed?: number;
};

export type SidecarStatus = {
  running: boolean;
  healthy: boolean;
  reason?: string;
};

export type SetupEnvironmentStatus = "ready" | "missing" | "starting" | "error";

export type TorchBackend = "cpu" | "cuda" | "mps";

export type SetupDiagnostics = {
  cpuName?: string | null;
  totalMemoryBytes?: number | null;
  availableStorageBytes?: number | null;
  recommendedMemoryBytes: number;
  minimumFreeStorageBytes: number;
  environmentReady: boolean;
  environmentStatus: SetupEnvironmentStatus;
  environmentReason?: string | null;
  gpuVendor?: string | null;
  gpuName?: string | null;
  hasNvidiaGpu?: boolean;
  activeTorchBackend?: TorchBackend | string | null;
};

export type ServiceInfo = {
  service: string;
  status: string;
  instanceId?: string;
  startedAt?: string;
  modelLoaded: boolean;
  asrLoaded: boolean;
  coreModelReady?: boolean;
  asrModelReady?: boolean;
  zipEnhancerReady?: boolean;
  speechToolsReady?: boolean;
  bootstrapAssetsReady?: boolean;
  version: string;
  deviceName?: string;
  deviceType?: string;
  audioOutputDir?: string;
  cacheBytes?: number;
  logLevel?: string;
  logDir?: string;
  logBytes?: number;
  storageDir?: string;
  modelDir?: string;
  modelBytes?: number;
  voicesDir?: string;
  voiceLibraryBytes?: number;
  huggingfaceCacheDir?: string;
  huggingfaceCacheBytes?: number;
  modelscopeCacheDir?: string;
  modelscopeCacheBytes?: number;
  torchCacheDir?: string;
  torchCacheBytes?: number;
  downloadCacheBytes?: number;
  managedStorageBytes?: number;
  bootstrapAssets?: BootstrapAssetStatus[];
  // True when a pre-ONNX FunASR SenseVoice directory still exists on disk.
  // The desktop UI presents a blocking migration dialog until the legacy
  // directory is removed, since the new ONNX runtime cannot load it.
  legacyAsrModelPresent?: boolean;
};

export type VoiceSourceType = "builtin" | "user";

export type VoiceEntry = {
  id: string;
  name: string;
  language: string;
  description: string;
  durationSeconds?: number;
  referenceAudioPath?: string;
  referenceTranscript?: string | null;
  transcriptLanguage?: string | null;
  sourceType: VoiceSourceType;
  canRename: boolean;
  canDelete: boolean;
  presetKey?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VoiceCreatePayload = {
  name: string;
  language: string;
  description: string;
  referenceAudioPath?: string;
  referenceTranscript?: string;
  transcriptLanguage?: string;
};

export type VoiceUpdatePayload = {
  name?: string;
  language?: string;
  description?: string;
  referenceTranscript?: string;
  transcriptLanguage?: string;
};

export type AudioTranscriptionPayload = {
  audioPath: string;
  modelKey?: string;
};
