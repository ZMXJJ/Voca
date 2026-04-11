import { invoke } from "@tauri-apps/api/core";
import type {
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderPreference,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";

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
      progress: 0,
      message: "Tauri command 尚未连通，当前展示的是前端降级占位数据。",
      result: null,
      error: null,
    };
  }
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  try {
    return await invoke<TaskRecord>("get_task", { taskId });
  } catch {
    return null;
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
