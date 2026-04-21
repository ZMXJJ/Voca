import { invoke } from "@tauri-apps/api/core";
import type {
  AudioTranscriptionPayload,
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderPreference,
  ProviderRecommendation,
  ServiceInfo,
  SetupDiagnostics,
  SidecarStatus,
  TaskRecord,
  VoiceCreatePayload,
  VoiceEntry,
  VoiceUpdatePayload,
} from "@voca/contracts";
import i18n from "../i18n";

export type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string | null;
};

type CacheClearResult = {
  success: boolean;
  clearedFiles: number;
  clearedBytes: number;
  remainingBytes: number;
  removedTasks: number;
  removedTaskIds: string[];
  clearedAudioDirs?: string[];
  serviceInfo?: ServiceInfo | null;
};

export type TaskQueryErrorKind = "sidecar_unavailable" | "request_failed";

export class TaskQueryError extends Error {
  kind: TaskQueryErrorKind;

  constructor(kind: TaskQueryErrorKind, message: string) {
    super(message);
    this.name = "TaskQueryError";
    this.kind = kind;
  }
}

const fallbackBootstrapState: BootstrapState = {
  isFirstLaunch: true,
  phase: "welcome",
  status: "idle",
  runtimeReady: false,
  modelReady: false,
  sidecarReady: false,
  currentDownloadJobId: null,
  lastError: null,
};

function getInvokeErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const maybeMessage = Reflect.get(error, "message");
    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return maybeMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function classifyTaskQueryError(message: string): TaskQueryErrorKind {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("python_sidecar_not_ready") ||
    normalized.includes("python_service_venv_missing") ||
    normalized.includes("tauri_not_available") ||
    normalized.includes("error sending request") ||
    normalized.includes("error trying to connect") ||
    normalized.includes("failed to connect") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset") ||
    normalized.includes("tcp connect error") ||
    normalized.includes("timed out")
  ) {
    return "sidecar_unavailable";
  }
  return "request_failed";
}

function createTaskQueryError(error: unknown, fallback: string): TaskQueryError {
  const message = getInvokeErrorMessage(error, fallback);
  return new TaskQueryError(classifyTaskQueryError(message), message);
}

export async function getQuickBootstrapState(): Promise<BootstrapState> {
  try {
    return await invoke<BootstrapState>("get_quick_bootstrap_state");
  } catch {
    return fallbackBootstrapState;
  }
}

export async function getBootstrapState(): Promise<BootstrapState> {
  try {
    return await invoke<BootstrapState>("get_bootstrap_state");
  } catch {
    return fallbackBootstrapState;
  }
}

export async function getSidecarStatus(): Promise<SidecarStatus> {
  try {
    return await invoke<SidecarStatus>("get_sidecar_status");
  } catch {
    return { running: false, healthy: false, reason: "tauri_not_available" };
  }
}

export async function getSetupDiagnostics(): Promise<SetupDiagnostics | null> {
  try {
    return await invoke<SetupDiagnostics>("get_setup_diagnostics");
  } catch {
    return null;
  }
}

export async function createGenerateTask(payload: GenerationParams): Promise<TaskRecord> {
  try {
    return await invoke<TaskRecord>("create_generate_task", { payload });
  } catch {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      type: "generate",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      title: payload.targetText.trim().slice(0, 80) || "Untitled task",
      voiceName: payload.voiceName?.trim() || undefined,
      progress: 0,
      message: i18n.t("system.tauriFallbackTaskMessage"),
      result: null,
      error: null,
    };
  }
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  try {
    return await invoke<TaskRecord | null>("get_task", { taskId });
  } catch {
    return null;
  }
}

export async function getTaskStrict(taskId: string): Promise<TaskRecord | null> {
  try {
    return await invoke<TaskRecord | null>("get_task", { taskId });
  } catch (error) {
    throw createTaskQueryError(error, "Failed to fetch task");
  }
}

export async function createAsrTask(payload: AudioTranscriptionPayload): Promise<TaskRecord> {
  try {
    return await invoke<TaskRecord>("create_asr_task", {
      audioPath: payload.audioPath,
      modelKey: payload.modelKey,
    });
  } catch (error) {
    throw new Error(getInvokeErrorMessage(error, "Failed to transcribe audio"));
  }
}

export async function getModelCatalog(): Promise<ModelCatalogEntry[]> {
  try {
    return await invoke<ModelCatalogEntry[]>("get_model_catalog");
  } catch {
    return [];
  }
}

export async function getProviderRecommendation(
  preferred: ProviderPreference = "auto",
): Promise<ProviderRecommendation | null> {
  try {
    return await invoke<ProviderRecommendation>("get_provider_recommendation", { preferred });
  } catch {
    return null;
  }
}

export async function prepareModel(
  modelKey: string,
  providerPreference: ProviderPreference,
  ensureDownloaded = false,
): Promise<ModelPrepareResponse | null> {
  try {
    return await invoke<ModelPrepareResponse>("prepare_model", {
      modelKey,
      providerPreference,
      ensureDownloaded,
    });
  } catch {
    return null;
  }
}

export async function startModelDownload(
  modelKey: string,
  providerPreference: ProviderPreference = "auto",
): Promise<TaskRecord | null> {
  try {
    return await invoke<TaskRecord>("start_model_download", {
      modelKey,
      providerPreference,
    });
  } catch {
    return null;
  }
}

export async function startBootstrapDownload(
  providerPreference: ProviderPreference = "auto",
): Promise<TaskRecord | null> {
  try {
    return await invoke<TaskRecord>("start_bootstrap_download", {
      providerPreference,
    });
  } catch {
    return null;
  }
}

export async function cleanupLegacyAsrModel(): Promise<boolean> {
  try {
    return await invoke<boolean>("cleanup_legacy_asr_model");
  } catch {
    return false;
  }
}

export async function completeOnboarding(): Promise<boolean> {
  try {
    return await invoke<boolean>("complete_onboarding");
  } catch {
    return false;
  }
}

export async function getServiceInfo(): Promise<ServiceInfo | null> {
  try {
    return await invoke<ServiceInfo>("get_service_info");
  } catch {
    return null;
  }
}

export async function listTasks(
  limit = 50,
  offset = 0,
  status?: string,
): Promise<TaskRecord[]> {
  try {
    return await invoke<TaskRecord[]>("list_tasks", { limit, offset, status });
  } catch {
    return [];
  }
}

export async function clearCache(): Promise<CacheClearResult | null> {
  try {
    return await invoke<CacheClearResult>("clear_cache");
  } catch {
    return null;
  }
}

export async function exportLogs(logDir: string): Promise<boolean> {
  try {
    return await invoke<boolean>("export_logs", { logDir });
  } catch {
    return false;
  }
}

export async function openStorageDirectory(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("open_storage_directory", { path });
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    return await invoke<boolean>("open_external_url", { url });
  } catch {
    return false;
  }
}

export async function openMicrophoneSettings(): Promise<boolean> {
  try {
    return await invoke<boolean>("open_microphone_settings");
  } catch {
    return false;
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return await invoke<UpdateCheckResult>("check_for_update");
}

export async function audioFileExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("audio_file_exists", { path });
  } catch {
    return false;
  }
}

export async function listVoices(): Promise<VoiceEntry[]> {
  try {
    return await invoke<VoiceEntry[]>("list_voices");
  } catch {
    return [];
  }
}

export async function getVoice(voiceId: string): Promise<VoiceEntry | null> {
  try {
    return await invoke<VoiceEntry>("get_voice", { voiceId });
  } catch {
    return null;
  }
}

export async function createVoice(payload: VoiceCreatePayload): Promise<VoiceEntry> {
  try {
    return await invoke<VoiceEntry>("create_voice", { payload });
  } catch (error) {
    throw new Error(getInvokeErrorMessage(error, "Failed to create voice"));
  }
}

export async function updateVoice(
  voiceId: string,
  payload: VoiceUpdatePayload,
): Promise<VoiceEntry> {
  try {
    return await invoke<VoiceEntry>("update_voice", { voiceId, payload });
  } catch (error) {
    throw new Error(getInvokeErrorMessage(error, "Failed to update voice"));
  }
}

export async function deleteVoice(voiceId: string): Promise<boolean> {
  try {
    return await invoke<boolean>("delete_voice", { voiceId });
  } catch (error) {
    throw new Error(getInvokeErrorMessage(error, "Failed to delete voice"));
  }
}

export async function pickAudioFile(): Promise<string | null> {
  try {
    return await invoke<string | null>("pick_audio_file");
  } catch {
    return null;
  }
}

export async function saveRecordedAudio(
  audioBase64: string,
  extension: string,
): Promise<string> {
  try {
    return await invoke<string>("save_recorded_audio", { audioBase64, extension });
  } catch (error) {
    throw new Error(getInvokeErrorMessage(error, "Failed to save recorded audio"));
  }
}

export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  try {
    return await invoke<string | null>("pick_directory", { defaultPath: defaultPath ?? null });
  } catch {
    return null;
  }
}
