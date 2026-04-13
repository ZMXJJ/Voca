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

export type TaskType = "bootstrap" | "generate" | "clone" | "asr_transcribe";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskRecord = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  progress?: number;
  message?: string;
  error?: AppError | null;
  result?: {
    audioPath?: string;
    sampleRate?: number;
    durationMs?: number;
    modelKey?: string;
    modelPath?: string;
    provider?: ModelProvider;
  } | null;
};

export type GenerationMode =
  | "quick_tts"
  | "voice_design"
  | "controllable_clone"
  | "ultimate_clone";

export type ModelProvider = "huggingface" | "modelscope" | "local";

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
  defaultProvider: Exclude<ModelProvider, "local">;
  localDir: string;
  providers: {
    huggingface?: {
      repoId: string;
    };
    modelscope?: {
      modelId: string;
    };
  };
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
  controlInstruction?: string;
  referenceAudioPath?: string;
  promptText?: string;
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

export type ServiceInfo = {
  service: string;
  status: string;
  modelLoaded: boolean;
  version: string;
  deviceType?: string;
  audioOutputDir?: string;
};

export type VoiceEntry = {
  id: string;
  name: string;
  language: string;
  durationSeconds?: number;
  audioPath?: string;
  isBuiltin: boolean;
};
