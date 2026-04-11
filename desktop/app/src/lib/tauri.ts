import { invoke } from "@tauri-apps/api/core";
import type { BootstrapState, GenerationParams, SidecarStatus, TaskRecord } from "@voca/contracts";

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
