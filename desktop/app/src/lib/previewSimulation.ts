import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapAssetDownloadProgress,
  GenerationParams,
  SetupDiagnostics,
  TaskRecord,
} from "@voca/contracts";

/**
 * Preview-mode simulation engine. Everything in this module is dev-tooling:
 * it fabricates bootstrap downloads, hardware profiles, and generation tasks
 * so the `?preview=` scenes animate like the real app without touching the
 * Tauri backend or the network. Nothing here runs in live mode.
 */

// ---------------------------------------------------------------------------
// Hardware profiles
// ---------------------------------------------------------------------------

export const SIM_PROFILE_KEYS = [
  "mac-silicon",
  "mac-low-ram",
  "win-nvidia",
  "win-igpu",
  "win-no-vulkan",
  "win-low-vram",
  "low-storage",
] as const;

export type SimProfileKey = (typeof SIM_PROFILE_KEYS)[number];

type SimAsset = {
  modelKey: string;
  displayName: string;
  totalBytes: number;
};

type SimProfile = {
  diagnostics: SetupDiagnostics;
  assets: SimAsset[];
};

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

// The real bootstrap bundle downloads the same two models on every platform:
// VoxCPM2 (GGUF) + SenseVoice (ONNX). The denoiser ships inside the app and
// the legacy Windows CUDA runtime download was retired with the Vulkan move.
const BOOTSTRAP_ASSETS: SimAsset[] = [
  { modelKey: "voxcpm2", displayName: "VoxCPM2 (GGUF)", totalBytes: 2.4 * GB },
  { modelKey: "sensevoice_small", displayName: "SenseVoiceSmall", totalBytes: 230 * MB },
];

const MAC_ASSETS = BOOTSTRAP_ASSETS;
const WIN_ASSETS = BOOTSTRAP_ASSETS;

const BASE_DIAGNOSTICS = {
  recommendedMemoryBytes: 12 * GB,
  minimumFreeStorageBytes: 6 * GB,
  environmentReady: true,
  environmentStatus: "ready" as const,
  environmentReason: null,
};

export const SIM_PROFILES: Record<SimProfileKey, SimProfile> = {
  "mac-silicon": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "macos",
      cpuName: "Apple M3 Pro",
      totalMemoryBytes: 16 * GB,
      availableStorageBytes: 500 * GB,
      gpuVendor: "apple",
      gpuName: "Apple M3 Pro GPU",
      hasNvidiaGpu: null,
      hasVulkanSupport: null,
      gpuMemoryBytes: null,
      minimumGpuMemoryBytes: null,
      activeTorchBackend: "mps",
    },
    assets: MAC_ASSETS,
  },
  "mac-low-ram": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "macos",
      cpuName: "Apple M1",
      totalMemoryBytes: 8 * GB,
      availableStorageBytes: 120 * GB,
      gpuVendor: "apple",
      gpuName: "Apple M1 GPU",
      hasNvidiaGpu: null,
      hasVulkanSupport: null,
      gpuMemoryBytes: null,
      minimumGpuMemoryBytes: null,
      activeTorchBackend: "mps",
    },
    assets: MAC_ASSETS,
  },
  "win-nvidia": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "windows",
      cpuName: "Intel Core Ultra 9",
      totalMemoryBytes: 32 * GB,
      availableStorageBytes: 42 * GB,
      gpuVendor: "nvidia",
      gpuName: "NVIDIA GeForce RTX 4070 Laptop GPU",
      hasNvidiaGpu: true,
      hasVulkanSupport: true,
      gpuMemoryBytes: 8 * GB,
      minimumGpuMemoryBytes: 6 * GB,
      activeTorchBackend: "cuda",
    },
    assets: WIN_ASSETS,
  },
  "win-igpu": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "windows",
      cpuName: "Intel Core i7-1360P",
      totalMemoryBytes: 32 * GB,
      availableStorageBytes: 200 * GB,
      gpuVendor: "other",
      gpuName: "Intel Iris Xe Graphics",
      hasNvidiaGpu: false,
      hasVulkanSupport: true,
      // WMI would report a tiny "dedicated" block here; the frontend hides
      // it and never warns because usable memory is shared system RAM.
      gpuMemoryBytes: 512 * MB,
      minimumGpuMemoryBytes: 6 * GB,
      activeTorchBackend: "vulkan",
    },
    assets: WIN_ASSETS,
  },
  "win-no-vulkan": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "windows",
      cpuName: "AMD Ryzen 7 5800H",
      totalMemoryBytes: 16 * GB,
      availableStorageBytes: 80 * GB,
      gpuVendor: "amd",
      gpuName: "AMD Radeon Graphics",
      hasNvidiaGpu: false,
      hasVulkanSupport: false,
      gpuMemoryBytes: null,
      minimumGpuMemoryBytes: 6 * GB,
      activeTorchBackend: "cpu",
    },
    assets: WIN_ASSETS,
  },
  "win-low-vram": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "windows",
      cpuName: "Intel Core i5-10300H",
      totalMemoryBytes: 16 * GB,
      availableStorageBytes: 60 * GB,
      gpuVendor: "nvidia",
      gpuName: "NVIDIA GeForce GTX 1650",
      hasNvidiaGpu: true,
      hasVulkanSupport: true,
      gpuMemoryBytes: 4 * GB,
      minimumGpuMemoryBytes: 6 * GB,
      activeTorchBackend: "cuda",
    },
    assets: WIN_ASSETS,
  },
  "low-storage": {
    diagnostics: {
      ...BASE_DIAGNOSTICS,
      platform: "macos",
      cpuName: "Apple M2",
      totalMemoryBytes: 16 * GB,
      availableStorageBytes: 3 * GB,
      gpuVendor: "apple",
      gpuName: "Apple M2 GPU",
      hasNvidiaGpu: null,
      hasVulkanSupport: null,
      gpuMemoryBytes: null,
      minimumGpuMemoryBytes: null,
      activeTorchBackend: "mps",
    },
    assets: MAC_ASSETS,
  },
};

/**
 * The initialize-page "can proceed" gate, extracted so live mode (real
 * diagnostics) and preview mode (simulated profiles) evaluate identical
 * rules — a blocked profile must actually disable the Next button.
 *
 * Windows gates on Vulkan support (the shipped backend is llama.cpp +
 * Vulkan, any GPU vendor qualifies); VRAM is advisory, never blocking.
 * A missing `hasVulkanSupport` field (older Rust shell) is treated as
 * "unknown" and does not block.
 */
export function evaluateInitializeGate(diagnostics: SetupDiagnostics | null): boolean {
  return Boolean(
    diagnostics &&
      (diagnostics.platform === "windows" ? diagnostics.hasVulkanSupport !== false : true) &&
      diagnostics.environmentReady &&
      (diagnostics.availableStorageBytes ?? 0) >= diagnostics.minimumFreeStorageBytes,
  );
}

// ---------------------------------------------------------------------------
// Download speed presets
// ---------------------------------------------------------------------------

export const SIM_SPEED_KEYS = ["fast", "normal", "slow", "flaky"] as const;

export type SimSpeedKey = (typeof SIM_SPEED_KEYS)[number];

const SIM_SPEEDS: Record<SimSpeedKey, { bps: number; jitter: number; stalls: boolean }> = {
  fast: { bps: 60 * MB, jitter: 0.15, stalls: false },
  normal: { bps: 12 * MB, jitter: 0.2, stalls: false },
  slow: { bps: 1.5 * MB, jitter: 0.25, stalls: false },
  flaky: { bps: 4 * MB, jitter: 0.4, stalls: true },
};

// ---------------------------------------------------------------------------
// Bootstrap download simulation
// ---------------------------------------------------------------------------

const TICK_MS = 250;

type SimDownloadState = {
  assetIndex: number;
  downloadedBytes: number;
  failed: boolean;
  done: boolean;
  stallUntil: number;
};

function initialDownloadState(): SimDownloadState {
  return { assetIndex: 0, downloadedBytes: 0, failed: false, done: false, stallUntil: 0 };
}

function buildAssetProgress(
  assets: SimAsset[],
  state: SimDownloadState,
  bytesPerSecond: number | null,
): BootstrapAssetDownloadProgress[] {
  return assets.map((asset, index) => {
    const isDone = state.done || index < state.assetIndex;
    const isCurrent = !state.done && index === state.assetIndex;
    const status = isDone
      ? "succeeded"
      : isCurrent
        ? state.failed
          ? "failed"
          : "running"
        : "pending";
    const downloaded = isDone ? asset.totalBytes : isCurrent ? state.downloadedBytes : 0;
    return {
      modelKey: asset.modelKey,
      displayName: asset.displayName,
      status,
      progress: Math.round((downloaded / asset.totalBytes) * 100),
      provider: "huggingface",
      currentFile: isCurrent ? asset.displayName : null,
      downloadedBytes: Math.round(downloaded),
      totalBytes: asset.totalBytes,
      totalBytesComplete: true,
      bytesPerSecond: isCurrent && !state.failed ? bytesPerSecond : null,
    };
  });
}

function buildSimTask(
  assets: SimAsset[],
  state: SimDownloadState,
  bytesPerSecond: number | null,
): TaskRecord {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.totalBytes, 0);
  const doneBytes =
    assets.slice(0, state.assetIndex).reduce((sum, asset) => sum + asset.totalBytes, 0) +
    state.downloadedBytes;
  const overallProgress = state.done ? 100 : Math.min(99, Math.round((doneBytes / totalBytes) * 100));
  const currentAsset = assets[Math.min(state.assetIndex, assets.length - 1)];
  const now = new Date().toISOString();

  return {
    id: "sim-bootstrap-task",
    type: "bootstrap",
    status: state.done ? "succeeded" : state.failed ? "failed" : "running",
    createdAt: now,
    updatedAt: now,
    title: "Prepare speech tools bundle",
    progress: overallProgress,
    message: state.done
      ? "Speech tools ready"
      : state.failed
        ? `Failed to download ${currentAsset.displayName}`
        : `Preparing ${currentAsset.displayName}`,
    downloadProgress: state.done
      ? null
      : {
          phase: "downloading",
          provider: "huggingface",
          currentFile: currentAsset.displayName,
          downloadedBytes: Math.round(state.downloadedBytes),
          totalBytes: currentAsset.totalBytes,
          totalBytesComplete: true,
          completedFiles: state.assetIndex,
          totalFiles: assets.length,
          bytesPerSecond: state.failed ? null : bytesPerSecond,
        },
    bootstrapAssetProgress: buildAssetProgress(assets, state, bytesPerSecond),
    error: state.failed
      ? {
          code: "SIM_DOWNLOAD_FAILED",
          message: `Simulated network failure while downloading ${currentAsset.displayName}`,
          userMessageKey: "error.download_failed",
          severity: "error",
          recoverable: true,
          actions: ["retry"],
        }
      : null,
    result: state.done
      ? {
          modelKey: "voxcpm2",
          modelPath: "~/Library/Application Support/Voca/models/voxcpm2_gguf",
          provider: "huggingface",
          completedAssets: assets.map((asset) => asset.modelKey),
        }
      : null,
  };
}

export type BootstrapSimulation = {
  task: TaskRecord;
  restart: () => void;
  failNext: () => void;
};

export function useBootstrapSimulation(options: {
  enabled: boolean;
  profileKey: SimProfileKey;
  speedKey: SimSpeedKey;
  paused: boolean;
}): BootstrapSimulation {
  const { enabled, profileKey, speedKey, paused } = options;
  const assets = SIM_PROFILES[profileKey].assets;
  const stateRef = useRef<SimDownloadState>(initialDownloadState());
  const [snapshot, setSnapshot] = useState<{ state: SimDownloadState; bps: number | null }>(() => ({
    state: initialDownloadState(),
    bps: null,
  }));

  // Reset when the profile changes — the asset list is different.
  useEffect(() => {
    stateRef.current = initialDownloadState();
    setSnapshot({ state: { ...stateRef.current }, bps: null });
  }, [profileKey]);

  useEffect(() => {
    if (!enabled || paused) {
      return;
    }

    const timer = window.setInterval(() => {
      const state = stateRef.current;
      if (state.done || state.failed) {
        return;
      }

      const speed = SIM_SPEEDS[speedKey];
      const nowMs = Date.now();

      if (speed.stalls) {
        if (nowMs < state.stallUntil) {
          setSnapshot({ state: { ...state }, bps: 0 });
          return;
        }
        if (Math.random() < 0.08) {
          state.stallUntil = nowMs + 1000 + Math.random() * 1000;
          return;
        }
      }

      const jitterFactor = 1 + (Math.random() * 2 - 1) * speed.jitter;
      const instantBps = speed.bps * jitterFactor;
      state.downloadedBytes += instantBps * (TICK_MS / 1000);

      const currentAsset = assets[state.assetIndex];
      if (state.downloadedBytes >= currentAsset.totalBytes) {
        if (state.assetIndex >= assets.length - 1) {
          state.done = true;
        } else {
          state.assetIndex += 1;
          state.downloadedBytes = 0;
        }
      }

      setSnapshot({ state: { ...state }, bps: Math.round(instantBps) });
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [assets, enabled, paused, speedKey]);

  const restart = useCallback(() => {
    stateRef.current = initialDownloadState();
    setSnapshot({ state: { ...stateRef.current }, bps: null });
  }, []);

  const failNext = useCallback(() => {
    if (stateRef.current.done) {
      return;
    }
    stateRef.current.failed = true;
    setSnapshot({ state: { ...stateRef.current }, bps: null });
  }, []);

  const task = useMemo(
    () => buildSimTask(assets, snapshot.state, paused ? null : snapshot.bps),
    [assets, paused, snapshot],
  );

  return { task, restart, failNext };
}

// ---------------------------------------------------------------------------
// Generation task simulation
// ---------------------------------------------------------------------------

export type GenerationSimulation = {
  sessionTasks: TaskRecord[];
  submitFake: (payload: GenerationParams) => Promise<void>;
  failureArmed: boolean;
  setFailureArmed: (armed: boolean) => void;
  clear: () => void;
};

const GENERATION_RUN_MS = 5000;

export function useGenerationSimulation(enabled: boolean): GenerationSimulation {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [failureArmed, setFailureArmed] = useState(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    if (enabled) {
      return;
    }
    // Leaving preview mode: drop fake tasks and cancel in-flight timers.
    // Deferred a tick so the cleanup isn't a synchronous setState in the
    // effect body (react-hooks/set-state-in-effect).
    const timer = window.setTimeout(() => {
      for (const pending of timersRef.current) window.clearTimeout(pending);
      timersRef.current = [];
      setTasks([]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    };
  }, []);

  const patchTask = useCallback((taskId: string, patch: Partial<TaskRecord>) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task,
      ),
    );
  }, []);

  const submitFake = useCallback(
    async (payload: GenerationParams) => {
      const taskId = `sim-gen-${Date.now()}`;
      const now = new Date().toISOString();
      const shouldFail = failureArmed;
      setFailureArmed(false);

      setTasks((current) => [
        {
          id: taskId,
          type: "generate",
          status: "queued",
          createdAt: now,
          updatedAt: now,
          title: payload.targetText.trim().slice(0, 80) || "Untitled task",
          voiceName: payload.voiceName?.trim() || undefined,
          progress: 0,
          message: "Queued (simulated)",
          result: null,
          error: null,
        },
        ...current,
      ]);

      const schedule = (delayMs: number, fn: () => void) => {
        timersRef.current.push(window.setTimeout(fn, delayMs));
      };

      schedule(600, () => patchTask(taskId, { status: "running", progress: 10, message: "Loading model (simulated)" }));
      schedule(GENERATION_RUN_MS * 0.4, () => patchTask(taskId, { progress: 45, message: "Generating audio (simulated)" }));
      schedule(GENERATION_RUN_MS * 0.75, () => patchTask(taskId, { progress: 80 }));
      schedule(GENERATION_RUN_MS, () => {
        if (shouldFail) {
          patchTask(taskId, {
            status: "failed",
            progress: 100,
            message: "Simulated inference failure",
            error: {
              code: "SIM_INFER_ERROR",
              message: "Simulated inference failure (injected from preview dock)",
              userMessageKey: "error.infer_runtime_error",
              severity: "error",
              recoverable: true,
              actions: ["retry"],
            },
          });
        } else {
          patchTask(taskId, {
            status: "succeeded",
            progress: 100,
            message: "Audio generated (simulated)",
            result: {
              audioPath: `/tmp/voca-sim/${taskId}.wav`,
              sampleRate: 16000,
              durationMs: 3000 + Math.round(Math.random() * 5000),
              modelKey: payload.modelKey ?? "voxcpm2",
            },
          });
        }
      });
    },
    [failureArmed, patchTask],
  );

  const clear = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
    setTasks([]);
  }, []);

  return { sessionTasks: tasks, submitFake, failureArmed, setFailureArmed, clear };
}
