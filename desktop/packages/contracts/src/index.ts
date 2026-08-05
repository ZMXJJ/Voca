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
  /**
   * Server-side EMA-smoothed transfer rate in bytes/second. Optional: older
   * sidecars omit this; the renderer falls back to a local sliding-window
   * estimate so the speed UI keeps working across versions. Only populated
   * while ``phase === "downloading"``.
   */
  bytesPerSecond?: number | null;
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
  bytesPerSecond?: number | null;
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
      allowPatterns?: string[];
      ignorePatterns?: string[];
    };
    modelscope?: {
      modelId: string;
      allowPatterns?: string[];
      ignorePatterns?: string[];
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
  voiceId?: string;
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

/**
 * A persisted generation result ("work"). Stored server-side in voca.db —
 * unlike TaskRecord these survive app restarts. Only successful generations
 * become works. `mode === "legacy_import"` marks rows imported from the
 * pre-SQLite localStorage history whose generation params are unknown.
 */
export type WorkEntry = {
  id: string;
  title: string;
  targetText: string;
  mode: GenerationMode | "legacy_import" | string;
  modelKey?: string | null;
  voiceId?: string | null;
  voiceName?: string | null;
  cfgValue?: number | null;
  inferenceTimesteps?: number | null;
  /** Requested seed; null = random (the backend does not report the seed it used). */
  seed?: number | null;
  normalize?: boolean | null;
  denoise?: boolean | null;
  extremeClone?: boolean | null;
  audioPath: string;
  rawAudioPath?: string | null;
  enhancedAudioPath?: string | null;
  sampleRate?: number | null;
  durationMs?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorksListResponse = {
  items: WorkEntry[];
  total: number;
};

export type WorkUpdatePayload = {
  title: string;
};

export type WorkVoiceFacet = {
  voiceId?: string | null;
  voiceName?: string | null;
  count: number;
};

export type WorkImportItem = {
  id: string;
  title?: string | null;
  targetText?: string | null;
  voiceName?: string | null;
  audioPath: string;
  rawAudioPath?: string | null;
  enhancedAudioPath?: string | null;
  sampleRate?: number | null;
  durationMs?: number | null;
  createdAt?: string | null;
};

export type WorksImportResult = {
  imported: number;
  skipped: number;
};

export type SidecarStatus = {
  running: boolean;
  healthy: boolean;
  reason?: string;
};

export type SetupEnvironmentStatus = "ready" | "missing" | "starting" | "error";

export type TorchBackend = "cpu" | "cuda" | "mps";

export type AppPlatform = "windows" | "macos" | "linux";

export type SetupDiagnostics = {
  /**
   * Host operating system identifier emitted by the Tauri backend. Older
   * builds (pre-Windows-integration) may not populate this field, so callers
   * should treat it as optional and fall back gracefully.
   */
  platform?: AppPlatform | string | null;
  cpuName?: string | null;
  totalMemoryBytes?: number | null;
  availableStorageBytes?: number | null;
  recommendedMemoryBytes: number;
  minimumFreeStorageBytes: number;
  gpuMemoryBytes?: number | null;
  /**
   * Advisory VRAM floor for the current platform's inference path (currently
   * only emitted on Windows). The Vulkan backend runs on any GPU, so the
   * frontend uses this for a "low VRAM" warning only — it is not a gate.
   */
  minimumGpuMemoryBytes?: number | null;
  environmentReady: boolean;
  environmentStatus: SetupEnvironmentStatus;
  environmentReason?: string | null;
  gpuVendor?: string | null;
  gpuName?: string | null;
  /**
   * Tri-state. `true`/`false` on Windows, `null`/`undefined` elsewhere.
   * Informational only — the bootstrap gate is `hasVulkanSupport`.
   */
  hasNvidiaGpu?: boolean | null;
  /**
   * Whether a Vulkan-capable driver stack is present. Populated on Windows
   * (whose inference backend is llama.cpp + Vulkan); `null`/`undefined` on
   * platforms that don't gate on Vulkan (macOS uses Metal). Absent on older
   * Rust shells — treat missing as "unknown, don't block".
   */
  hasVulkanSupport?: boolean | null;
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
  /**
   * @deprecated Storage byte counters are no longer measured by the health
   * route — the server always returns 0 here. Use ``StorageInfo`` via
   * ``getStorageInfo()`` instead. Field retained for binary compatibility
   * with older builds that still read it.
   */
  cacheBytes?: number;
  logLevel?: string;
  logDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  logBytes?: number;
  storageDir?: string;
  modelDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  modelBytes?: number;
  voicesDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  voiceLibraryBytes?: number;
  huggingfaceCacheDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  huggingfaceCacheBytes?: number;
  modelscopeCacheDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  modelscopeCacheBytes?: number;
  torchCacheDir?: string;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  torchCacheBytes?: number;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  downloadCacheBytes?: number;
  /** @deprecated See ``cacheBytes``; use ``StorageInfo`` instead. */
  managedStorageBytes?: number;
  bootstrapAssets?: BootstrapAssetStatus[];
  // True when a pre-ONNX FunASR SenseVoice directory still exists on disk.
  // The desktop UI presents a blocking migration dialog until the legacy
  // directory is removed, since the new ONNX runtime cannot load it.
  legacyAsrModelPresent?: boolean;
};

/**
 * Lazy storage usage snapshot returned by the dedicated
 * ``GET /api/v1/storage-info`` endpoint. Computing this on Windows can take
 * seconds, so the desktop UI requests it only when the user opens the
 * storage details modal — the regular health probe never walks the
 * filesystem any more.
 */
export type StorageInfo = {
  audioOutputDir?: string;
  cacheBytes: number;
  logDir?: string;
  logBytes: number;
  storageDir?: string;
  modelDir?: string;
  modelBytes: number;
  voicesDir?: string;
  voiceLibraryBytes: number;
  huggingfaceCacheDir?: string;
  huggingfaceCacheBytes: number;
  modelscopeCacheDir?: string;
  modelscopeCacheBytes: number;
  torchCacheDir?: string;
  torchCacheBytes: number;
  downloadCacheBytes: number;
  managedStorageBytes: number;
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
