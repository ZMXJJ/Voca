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
  } | null;
};

export type GenerationMode =
  | "quick_tts"
  | "voice_design"
  | "controllable_clone"
  | "ultimate_clone";

export type GenerationParams = {
  mode: GenerationMode;
  targetText: string;
  controlInstruction?: string;
  referenceAudioPath?: string;
  promptText?: string;
  cfgValue?: number;
  inferenceTimesteps?: number;
  normalize?: boolean;
  denoise?: boolean;
  streaming?: boolean;
};

export type SidecarStatus = {
  running: boolean;
  healthy: boolean;
  reason?: string;
};
