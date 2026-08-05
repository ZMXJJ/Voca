import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SetupDiagnostics,
  SidecarStatus,
  StorageInfo,
  TaskRecord,
  WorkEntry,
  WorkImportItem,
} from "@voca/contracts";
import { PreviewDock } from "./components/PreviewDock";
import { getTaskPlayableAudioPath } from "./lib/taskUtils";
import {
  evaluateInitializeGate,
  SIM_PROFILES,
  useBootstrapSimulation,
  useGenerationSimulation,
  type SimProfileKey,
  type SimSpeedKey,
} from "./lib/previewSimulation";
import { BootstrapFlowPage } from "./pages/BootstrapFlowPage";
import { PreviewGalleryPage } from "./pages/PreviewGalleryPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { getPreviewModeFromSearch, type PreviewMode, type SinglePreviewScene } from "./preview";
import { IconVocaLogo } from "./components/Icons";
import i18n from "./i18n";
import {
  checkForUpdate,
  completeOnboarding,
  createGenerateTask,
  getBootstrapState,
  getModelCatalog,
  getProviderRecommendation,
  getQuickBootstrapState,
  getServiceInfo,
  getStorageInfo,
  getSetupDiagnostics,
  getSidecarStatus,
  getTask,
  importWorks,
  listWorks,
  prepareModel,
  startBootstrapDownload,
  cleanupLegacyAsrModel,
  getBootstrapSidecarStatus,
  type UpdateCheckResult,
} from "./lib/tauri";
import {
  LegacyAsrMigrationModal,
  type LegacyAsrMigrationState,
} from "./components/LegacyAsrMigrationModal";
import { UpdateAvailableModal } from "./components/UpdateAvailableModal";
import { useModalTransition } from "./lib/useModalTransition";

type AppView = "loading" | "welcome" | "download" | "initialize" | "complete" | "workspace";
const DEFAULT_BOOTSTRAP_MODEL_KEY = "voxcpm2";

const fallbackBootstrapState: BootstrapState = {
  isFirstLaunch: true,
  phase: "welcome",
  status: "idle",
  runtimeReady: false,
  modelReady: false,
  sidecarReady: false,
  currentDownloadJobId: null,
  lastError: null,
  needsRepair: false,
};

const fallbackProviderRecommendation: ProviderRecommendation = {
  publicIp: null,
  location: null,
  preferred: "auto",
  recommended: "huggingface",
  current: "huggingface",
  reason: "default_fallback",
  userOverridden: false,
};

function createPreviewBootstrapState(
  base: BootstrapState,
  scene: SinglePreviewScene,
): BootstrapState {
  switch (scene) {
    case "download":
      return {
        ...base,
        isFirstLaunch: true,
        phase: "model_download",
        status: "running",
        runtimeReady: true,
        modelReady: false,
        sidecarReady: false,
      };
    case "welcome":
      return {
        ...base,
        isFirstLaunch: true,
        phase: "welcome",
        status: "idle",
        runtimeReady: false,
        modelReady: false,
        sidecarReady: false,
      };
    case "initialize":
      return {
        ...base,
        isFirstLaunch: true,
        phase: "warmup",
        status: "running",
        runtimeReady: true,
        modelReady: true,
        sidecarReady: false,
      };
    case "complete":
      return {
        ...base,
        isFirstLaunch: true,
        phase: "ready",
        status: "ready",
        runtimeReady: true,
        modelReady: true,
        sidecarReady: true,
      };
    case "workspace":
      return {
        ...base,
        isFirstLaunch: false,
        phase: "ready",
        status: "ready",
        runtimeReady: true,
        modelReady: true,
        sidecarReady: true,
      };
    default:
      return base;
  }
}

function createPreviewSidecarStatus(
  base: SidecarStatus,
  scene: SinglePreviewScene,
): SidecarStatus {
  if (scene === "initialize") {
    return {
      running: true,
      healthy: false,
      reason: "preview_booting",
    };
  }

  return {
    ...base,
    running: true,
    healthy: true,
    reason: "preview_ready",
  };
}

function createPreviewPreparedModel(
  base: ModelPrepareResponse | null,
  recommendation: ProviderRecommendation,
  scene: SinglePreviewScene,
): ModelPrepareResponse {
  if (base) {
    return {
      ...base,
      configExists: scene !== "download",
      existsLocally: scene !== "download",
      provider: recommendation.current,
      recommendation,
    };
  }

  return {
    modelKey: "voxcpm2",
    modelPath: "~/Library/Application Support/Voca/models/voxcpm2_gguf",
    provider: recommendation.current,
    existsLocally: scene !== "download",
    configExists: scene !== "download",
    recommendation,
  };
}

function createPreviewTask(task: TaskRecord | null): TaskRecord {
  if (task) {
    return task;
  }

  const now = new Date().toISOString();

  return {
    id: "preview-task",
    type: "generate",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    title: "preview task",
    voiceName: i18n.t("preview.sceneTag"),
    progress: 100,
    message: "preview_task",
    error: null,
    result: {
      audioPath: "~/Library/Application Support/Voca/outputs/preview.wav",
      sampleRate: 48000,
      durationMs: 4320,
    },
  };
}

const SESSION_TASK_LIMIT = 50;

function upsertTaskHistory(history: TaskRecord[], task: TaskRecord): TaskRecord[] {
  return [task, ...history.filter((item) => item.id !== task.id)]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, SESSION_TASK_LIMIT);
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/");
}

function isTaskAudioUnderDirs(task: TaskRecord, clearedAudioDirs: string[]) {
  if (clearedAudioDirs.length === 0) {
    return false;
  }
  const audioPath = getTaskPlayableAudioPath(task);
  if (!audioPath) {
    return false;
  }
  const normalizedAudio = normalizePath(audioPath);
  return clearedAudioDirs.some((dir) => {
    const normalizedDir = normalizePath(dir);
    return normalizedAudio === normalizedDir || normalizedAudio.startsWith(`${normalizedDir}/`);
  });
}

function isTaskTerminal(task: TaskRecord | null) {
  return !task || ["succeeded", "failed", "cancelled"].includes(task.status);
}

function App() {
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>({
    running: false,
    healthy: false,
    reason: "loading",
  });
  const [providerRecommendation, setProviderRecommendation] = useState<ProviderRecommendation | null>(null);
  const [preparedModel, setPreparedModel] = useState<ModelPrepareResponse | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [downloadedModelCatalog, setDownloadedModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [auxiliaryModelCatalog, setAuxiliaryModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [downloadedAuxiliaryModelCatalog, setDownloadedAuxiliaryModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  // Lazy storage usage snapshot. ``null`` until the user opens the storage
  // details modal in Settings — at that point the modal triggers
  // ``refreshStorageInfo`` to fetch the (potentially several-second-long)
  // recursive directory walk. We hold the result here so it survives tab
  // switches and stays visible on the Settings page after the modal closes.
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [setupDiagnostics, setSetupDiagnostics] = useState<SetupDiagnostics | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [bootstrapDownloadTask, setBootstrapDownloadTask] = useState<TaskRecord | null>(null);
  // In-flight and failed generate tasks of this session only. Successful
  // generations are persisted server-side as works (voca.db) and surface via
  // ``works`` below — nothing is written to localStorage any more.
  const [sessionTasks, setSessionTasks] = useState<TaskRecord[]>([]);
  const [works, setWorks] = useState<WorkEntry[]>([]);
  const [worksTotal, setWorksTotal] = useState(0);
  const [completionAcknowledged, setCompletionAcknowledged] = useState(false);
  const [finalizedBootstrapTaskId, setFinalizedBootstrapTaskId] = useState<string | null>(null);
  const [initializeRequested, setInitializeRequested] = useState(false);
  const [bootstrapStartRequested, setBootstrapStartRequested] = useState(false);
  const [legacyAsrMigrationState, setLegacyAsrMigrationState] =
    useState<LegacyAsrMigrationState>("idle");
  const [autoUpdateResult, setAutoUpdateResult] = useState<UpdateCheckResult | null>(null);
  const autoUpdateModal = useModalTransition(autoUpdateResult !== null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() =>
    typeof window === "undefined" ? "live" : getPreviewModeFromSearch(window.location.search),
  );

  // Preview-mode simulation controls (dev tooling). The hooks are called
  // unconditionally per the rules of hooks; `enabled` gates their timers.
  const [simProfileKey, setSimProfileKey] = useState<SimProfileKey>("mac-silicon");
  const [simSpeedKey, setSimSpeedKey] = useState<SimSpeedKey>("normal");
  const [simPaused, setSimPaused] = useState(false);
  const isPreviewActive = previewMode !== "live";
  const bootstrapSim = useBootstrapSimulation({
    enabled: isPreviewActive && (previewMode === "download" || previewMode === "all"),
    profileKey: simProfileKey,
    speedKey: simSpeedKey,
    paused: simPaused,
  });
  const generationSim = useGenerationSimulation(isPreviewActive);

  useEffect(() => {
    const handlePopState = () => {
      setPreviewMode(getPreviewModeFromSearch(window.location.search));
    };

    window.addEventListener("popstate", handlePopState);

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const shouldUseFullHealthChecks = Boolean(
    bootstrapState &&
      ((!bootstrapState.isFirstLaunch && !bootstrapState.needsRepair) || completionAcknowledged),
  );

  const refreshModelCatalogState = async () => {
    const catalog = await getModelCatalog();
    const ttsCatalog = catalog.filter((entry) => entry.assetRole === "tts");
    const auxCatalog = catalog.filter((entry) => entry.assetRole !== "tts");
    setModelCatalog(ttsCatalog);
    setAuxiliaryModelCatalog(auxCatalog);

    const preparedEntries = await Promise.all(
      catalog.map(async (entry) => ({
        entry,
        prepared: await prepareModel(entry.modelKey, "auto", false),
      })),
    );

    const downloaded = preparedEntries.filter(({ prepared }) => prepared?.configExists);
    setDownloadedModelCatalog(
      downloaded.filter(({ entry }) => entry.assetRole === "tts").map(({ entry }) => entry),
    );
    setDownloadedAuxiliaryModelCatalog(
      downloaded.filter(({ entry }) => entry.assetRole !== "tts").map(({ entry }) => entry),
    );
  };

  const refreshServiceInfo = async () => {
    const info = await getServiceInfo();
    setServiceInfo(info);
  };

  const refreshStorageInfo = useCallback(async () => {
    const info = await getStorageInfo();
    if (info) {
      setStorageInfo(info);
      return;
    }
    // Surface the failure so callers (e.g. StorageModal) can render a
    // retry affordance instead of silently leaving stale placeholders.
    throw new Error("storage_info_unavailable");
  }, []);

  const refreshSetupDiagnostics = async () => {
    const diagnostics = await getSetupDiagnostics();
    setSetupDiagnostics(diagnostics);
  };

  const refreshWorks = useCallback(async () => {
    const response = await listWorks({ limit: 50, offset: 0 });
    setWorks(response.items);
    setWorksTotal(response.total);
  }, []);

  const refreshBootstrapState = async () => {
    const [bs, ss] = await Promise.all([
      getBootstrapState(),
      shouldUseFullHealthChecks ? getSidecarStatus() : getBootstrapSidecarStatus(),
    ]);
    setBootstrapState(bs);
    setSidecarStatus(ss);
    if (ss.healthy && bs.currentDownloadJobId) {
      void getTask(bs.currentDownloadJobId).then((task) => setBootstrapDownloadTask(task));
    } else {
      setBootstrapDownloadTask((current) => {
        if (!current) {
          return null;
        }
        if (!bs.isFirstLaunch || bs.phase === "ready") {
          return null;
        }
        return ["queued", "running", "succeeded", "failed", "cancelled"].includes(current.status)
          ? current
          : null;
      });
    }
    // ``refreshServiceInfo`` is intentionally outside the
    // ``shouldUseFullHealthChecks`` guard: during first-launch bootstrap the
    // ready summary card needs ``serviceInfo.deviceType`` / ``deviceName`` to
    // render the inference device, otherwise it falls back to "检查中…" forever.
    if (ss.healthy) {
      void refreshServiceInfo();
    }
    if (shouldUseFullHealthChecks && ss.healthy) {
      void getProviderRecommendation("auto").then(setProviderRecommendation);
      void prepareModel(DEFAULT_BOOTSTRAP_MODEL_KEY, "auto", false).then(setPreparedModel);
      void refreshModelCatalogState();
    }
  };

  useEffect(() => {
    void getQuickBootstrapState().then((quickState) => {
      setBootstrapState(quickState);
      void refreshBootstrapState();
    });
  }, []);

  // Auto update check: run at most once per local calendar day on cold start.
  // We persist ``voca.lastUpdateCheckDate`` (YYYY-MM-DD in the user's local
  // timezone) so the check is skipped on the second and later launches the
  // same day. On success with an available update we surface the same modal
  // that the Settings page uses, non-blockingly (the overlay can be dismissed).
  useEffect(() => {
    const STORAGE_KEY = "voca.lastUpdateCheckDate";
    const today = (() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    })();

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === today) {
      return;
    }

    let cancelled = false;
    void checkForUpdate()
      .then((data) => {
        if (cancelled) {
          return;
        }
        try {
          window.localStorage.setItem(STORAGE_KEY, today);
        } catch {
          // Ignore storage failures — worst case we re-check tomorrow's first launch.
        }
        if (data.updateAvailable) {
          setAutoUpdateResult(data);
        }
      })
      .catch(() => {
        // Network failure: keep ``stored`` untouched so we'll retry on the
        // next cold launch (including later today if the user relaunches).
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sidecarStatus.healthy) return;
    const timer = window.setInterval(() => {
      void refreshBootstrapState();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sidecarStatus.healthy]);

  // Note: there is intentionally no recurring poll of ``getServiceInfo``
  // here. The health route is now a pure readiness probe (no disk walk),
  // and storage statistics are fetched lazily via ``refreshStorageInfo``
  // when the user opens the storage details modal. Background polling is
  // unnecessary and would just consume IO + battery for no UI benefit.

  useEffect(() => {
    if (!shouldUseFullHealthChecks) {
      return;
    }

    let cancelled = false;
    void getSidecarStatus().then((status) => {
      if (cancelled) {
        return;
      }
      setSidecarStatus(status);
      if (status.healthy) {
        void getProviderRecommendation("auto").then(setProviderRecommendation);
        void prepareModel(DEFAULT_BOOTSTRAP_MODEL_KEY, "auto", false).then(setPreparedModel);
        void refreshModelCatalogState();
        void refreshServiceInfo();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [shouldUseFullHealthChecks]);

  useEffect(() => {
    if (!initializeRequested || bootstrapStartRequested) {
      return;
    }

    void refreshSetupDiagnostics();
    const timer = window.setInterval(() => {
      void refreshSetupDiagnostics();
    }, 2500);

    return () => window.clearInterval(timer);
  }, [bootstrapStartRequested, initializeRequested]);

  // Initial works fetch + one-time localStorage history migration, both
  // gated on a healthy sidecar. The migration imports the pre-SQLite
  // localStorage task history (succeeded generations with audio) into the
  // server-side works DB, then retires the old key. The flag is only set
  // after the import resolves — failed imports retry on the next launch,
  // which is safe because the server inserts are idempotent by task id.
  const worksMigrationStarted = useRef(false);
  useEffect(() => {
    if (!sidecarStatus.healthy || !shouldUseFullHealthChecks) {
      return;
    }
    if (worksMigrationStarted.current) {
      return;
    }
    worksMigrationStarted.current = true;

    const MIGRATED_FLAG = "voca.taskHistory.migrated.v1";
    const LEGACY_KEY = "voca.taskHistory.v1";

    void (async () => {
      try {
        if (!window.localStorage.getItem(MIGRATED_FLAG)) {
          const raw = window.localStorage.getItem(LEGACY_KEY);
          const items: WorkImportItem[] = [];
          if (raw) {
            try {
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                for (const value of parsed) {
                  if (typeof value !== "object" || value === null) continue;
                  const task = value as Partial<TaskRecord>;
                  if (task.status !== "succeeded" || typeof task.id !== "string") continue;
                  const audioPath =
                    task.result?.audioPath ?? task.result?.enhancedAudioPath ?? task.result?.rawAudioPath;
                  if (!audioPath) continue;
                  items.push({
                    id: task.id,
                    title: task.title ?? null,
                    targetText: task.title ?? null,
                    voiceName: task.voiceName ?? null,
                    audioPath,
                    rawAudioPath: task.result?.rawAudioPath ?? null,
                    enhancedAudioPath: task.result?.enhancedAudioPath ?? null,
                    sampleRate: task.result?.sampleRate ?? null,
                    durationMs: task.result?.durationMs ?? null,
                    createdAt: task.createdAt ?? null,
                  });
                }
              }
            } catch {
              // Unparseable legacy payload — nothing to migrate.
            }
          }
          if (items.length > 0) {
            await importWorks(items);
          }
          window.localStorage.setItem(MIGRATED_FLAG, "1");
          window.localStorage.removeItem(LEGACY_KEY);
        }
      } catch (error) {
        // Import failed (e.g. sidecar restarted mid-call): leave the flag
        // unset so the next launch retries, but still load the works list.
        worksMigrationStarted.current = false;
        console.error("Legacy task history migration failed", error);
      }
      await refreshWorks();
    })();
  }, [refreshWorks, shouldUseFullHealthChecks, sidecarStatus.healthy]);

  useEffect(() => {
    if (runningTaskIds.size === 0) {
      return;
    }

    const ids = [...runningTaskIds];
    const timer = window.setInterval(() => {
      for (const taskId of ids) {
        void getTask(taskId).then((task) => {
          if (task) {
            setSessionTasks((history) => upsertTaskHistory(history, task));
            if (["succeeded", "failed", "cancelled"].includes(task.status)) {
              setRunningTaskIds((prev) => {
                const next = new Set(prev);
                next.delete(taskId);
                return next;
              });
              if (task.status === "succeeded" && task.type === "generate") {
                // The sidecar persisted the work before flipping the task to
                // succeeded, so this refetch is guaranteed to include it.
                // Only drop the session task once the works list has the row,
                // so the Studio mini history never flickers empty.
                void refreshWorks().then(() => {
                  setSessionTasks((history) => history.filter((item) => item.id !== taskId));
                });
              }
            }
          } else {
            setRunningTaskIds((prev) => {
              const next = new Set(prev);
              next.delete(taskId);
              return next;
            });
            setSessionTasks((history) =>
              history.map((item) =>
                item.id === taskId && !["succeeded", "failed", "cancelled"].includes(item.status)
                  ? { ...item, status: "failed" as const, message: "Task lost (service may have restarted)" }
                  : item,
              ),
            );
          }
        });
      }
    }, 600);

    return () => window.clearInterval(timer);
  }, [refreshWorks, runningTaskIds]);

  useEffect(() => {
    if (!bootstrapDownloadTask || isTaskTerminal(bootstrapDownloadTask)) {
      return;
    }

    const downloadTaskId = bootstrapDownloadTask.id;
    const timer = window.setInterval(() => {
      void getTask(downloadTaskId).then((task) => {
        if (task) {
          setBootstrapDownloadTask(task);
        }
      });
    }, 600);

    return () => window.clearInterval(timer);
  }, [bootstrapDownloadTask]);

  useEffect(() => {
    if (!bootstrapDownloadTask) {
      return;
    }

    if (bootstrapDownloadTask.status === "succeeded" && finalizedBootstrapTaskId !== bootstrapDownloadTask.id) {
      setFinalizedBootstrapTaskId(bootstrapDownloadTask.id);
      void (async () => {
        try {
          const prepared = await prepareModel(
            bootstrapDownloadTask.result?.modelKey ?? DEFAULT_BOOTSTRAP_MODEL_KEY,
            "auto",
            false,
          );
          setPreparedModel(prepared);
          setBootstrapState((current) =>
            current
              ? {
                  ...current,
                  phase: "ready",
                  status: "ready",
                  runtimeReady: true,
                  modelReady: prepared?.configExists ?? true,
                  sidecarReady: sidecarStatus.healthy || current.sidecarReady,
                  currentDownloadJobId: null,
                  lastError: null,
                  needsRepair: false,
                }
              : current,
          );
          await refreshModelCatalogState();
          // Pull the freshest ``serviceInfo`` immediately so the bootstrap
          // ready summary surfaces the inference device + ASR/enhancer
          // readiness without waiting for the next poll cycle.
          await refreshServiceInfo();
        } catch (error) {
          console.error("Failed to finalize bootstrap success state", error);
          setBootstrapState((current) =>
            current
              ? {
                  ...current,
                  phase: "ready",
                  status: "ready",
                  runtimeReady: true,
                  modelReady: true,
                  sidecarReady: sidecarStatus.healthy || current.sidecarReady,
                  currentDownloadJobId: null,
                  lastError: null,
                  needsRepair: false,
                }
              : current,
          );
        } finally {
          await refreshBootstrapState();
        }
      })();
      return;
    }

    if (bootstrapDownloadTask.status === "failed" || bootstrapDownloadTask.status === "cancelled") {
      void refreshBootstrapState();
    }
  }, [bootstrapDownloadTask, finalizedBootstrapTaskId]);

  useEffect(() => {
    if (!bootstrapState?.needsRepair) {
      return;
    }
    const modelReady = bootstrapState.modelReady;
    if (modelReady) {
      return;
    }
    if (!sidecarStatus.healthy) {
      return;
    }
    if (bootstrapStartRequested) {
      return;
    }
    if (bootstrapDownloadTask && !isTaskTerminal(bootstrapDownloadTask)) {
      return;
    }
    setBootstrapStartRequested(true);
  }, [
    bootstrapDownloadTask,
    bootstrapStartRequested,
    bootstrapState?.modelReady,
    bootstrapState?.needsRepair,
    sidecarStatus.healthy,
  ]);

  useEffect(() => {
    if (!bootstrapStartRequested) {
      return;
    }

    const modelReady = bootstrapState?.modelReady ?? false;
    const repairRequested = Boolean(bootstrapState?.needsRepair);
    if (modelReady || (!bootstrapState?.isFirstLaunch && !repairRequested)) {
      setBootstrapStartRequested(false);
      return;
    }

    if (!sidecarStatus.healthy) {
      return;
    }

    if (bootstrapDownloadTask && !isTaskTerminal(bootstrapDownloadTask)) {
      setBootstrapStartRequested(false);
      return;
    }

    let cancelled = false;
    void getProviderRecommendation("auto").then(setProviderRecommendation);
    void startBootstrapDownload("auto")
      .then((task) => {
        if (cancelled) {
          return;
        }
        if (task) {
          setBootstrapDownloadTask(task);
          setFinalizedBootstrapTaskId(null);
          setInitializeRequested(false);
          setBootstrapState((current) =>
            current
              ? {
                  ...current,
                  phase: "model_download",
                  status: "running",
                  runtimeReady: true,
                  sidecarReady: true,
                  modelReady: false,
                  currentDownloadJobId: task.id,
                  lastError: null,
                }
              : current,
          );
          setBootstrapStartRequested(false);
          return;
        }

        setBootstrapStartRequested(false);
        void refreshBootstrapState();
      })
      .catch(() => {
        if (!cancelled) {
          setBootstrapStartRequested(false);
          void refreshBootstrapState();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    bootstrapDownloadTask,
    bootstrapStartRequested,
    bootstrapState?.isFirstLaunch,
    bootstrapState?.modelReady,
    sidecarStatus.healthy,
  ]);

  const handlePrepareModel = async (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => {
    const recommendation = await getProviderRecommendation(providerPreference);
    setProviderRecommendation(recommendation);
    const prepared = await prepareModel(modelKey, providerPreference, ensureDownloaded);
    setPreparedModel(prepared);
    await refreshModelCatalogState();
    await refreshServiceInfo();
  };

  const handleSubmitTask = async (payload: GenerationParams) => {
    const task = await createGenerateTask(payload);
    setSessionTasks((history) => upsertTaskHistory(history, task));
    if (!["succeeded", "failed", "cancelled"].includes(task.status)) {
      setRunningTaskIds((prev) => new Set(prev).add(task.id));
    }
  };

  const handleCacheCleared = (
    nextStorageInfo: StorageInfo | null,
    removedTaskIds: string[],
    _remainingBytes: number,
    clearedAudioDirs: string[],
  ) => {
    const removedIdSet = new Set(removedTaskIds);
    setSessionTasks((history) =>
      history.filter((task) => {
        if (removedIdSet.has(task.id)) return false;
        if (isTaskAudioUnderDirs(task, clearedAudioDirs)) return false;
        if (isTaskTerminal(task) && !getTaskPlayableAudioPath(task)) return false;
        return true;
      }),
    );
    setRunningTaskIds((prev) => {
      const next = new Set(prev);
      for (const id of removedIdSet) next.delete(id);
      return next;
    });
    // The sidecar already deleted the affected work rows; re-pull the list.
    void refreshWorks();

    if (nextStorageInfo) {
      setStorageInfo(nextStorageInfo);
    }
  };

  const setPreviewInUrl = (mode: PreviewMode) => {
    const url = new URL(window.location.href);

    if (mode === "live") {
      url.searchParams.delete("preview");
    } else {
      url.searchParams.set("preview", mode);
    }

    window.history.replaceState({}, "", url);
    setPreviewMode(mode);
  };

  const previewOverlay = (
    <>
      {import.meta.env.DEV && (
        <PreviewDock
          mode={previewMode}
          onChange={setPreviewInUrl}
          sim={{
            profileKey: simProfileKey,
            onProfileChange: setSimProfileKey,
            speedKey: simSpeedKey,
            onSpeedChange: setSimSpeedKey,
            paused: simPaused,
            onTogglePaused: () => setSimPaused((value) => !value),
            onRestart: () => {
              setSimPaused(false);
              bootstrapSim.restart();
              generationSim.clear();
            },
            onInjectFailure: () => {
              if (previewMode === "workspace") {
                generationSim.setFailureArmed(!generationSim.failureArmed);
              } else {
                bootstrapSim.failNext();
              }
            },
            failureArmed: generationSim.failureArmed,
          }}
        />
      )}
    </>
  );

  const previewRecommendation = providerRecommendation ?? fallbackProviderRecommendation;
  const previewTask = createPreviewTask(null);
  const previewSetupDiagnostics = SIM_PROFILES[simProfileKey].diagnostics;
  const previewSessionTasks =
    generationSim.sessionTasks.length > 0 ? generationSim.sessionTasks : [previewTask];
  const canContinueFromInitialize = evaluateInitializeGate(setupDiagnostics);
  const renderPreviewScene = (scene: SinglePreviewScene) => {
    const previewBootstrapState = createPreviewBootstrapState(bootstrapState ?? fallbackBootstrapState, scene);
    const previewSidecarStatus = createPreviewSidecarStatus(sidecarStatus, scene);
    const previewPreparedModel = createPreviewPreparedModel(preparedModel, previewRecommendation, scene);
    const previewBootstrapModel =
      modelCatalog.find((model) => model.modelKey === DEFAULT_BOOTSTRAP_MODEL_KEY) ?? null;

    if (scene === "workspace") {
      return (
        <WorkspacePage
          bootstrapState={previewBootstrapState}
          sidecarStatus={previewSidecarStatus}
          providerRecommendation={previewRecommendation}
          preparedModel={previewPreparedModel}
          modelCatalog={modelCatalog}
          downloadedModelCatalog={downloadedModelCatalog}
          auxiliaryModelCatalog={auxiliaryModelCatalog}
          downloadedAuxiliaryModelCatalog={downloadedAuxiliaryModelCatalog}
          serviceInfo={serviceInfo}
          storageInfo={storageInfo}
          sessionTasks={previewSessionTasks}
          works={[]}
          worksTotal={0}
          onRefreshWorks={async () => {}}
          onPrepareModel={handlePrepareModel}
          onSubmitTask={generationSim.submitFake}
          onRefreshStorageInfo={refreshStorageInfo}
          onCacheCleared={handleCacheCleared}
        />
      );
    }

    return (
      <BootstrapFlowPage
        view={scene}
        bootstrapState={previewBootstrapState}
        providerRecommendation={previewRecommendation}
        preparedModel={previewPreparedModel}
        sidecarStatus={previewSidecarStatus}
        serviceInfo={serviceInfo}
        setupDiagnostics={scene === "initialize" ? previewSetupDiagnostics : setupDiagnostics}
        downloadTask={scene === "download" ? bootstrapSim.task : null}
        bootstrapModel={previewBootstrapModel}
        onStartSetup={() => setPreviewInUrl("initialize")}
        onProceedFromInitialize={() => setPreviewInUrl("download")}
        canProceedFromInitialize={
          scene === "initialize" ? evaluateInitializeGate(previewSetupDiagnostics) : canContinueFromInitialize
        }
        onEnterWorkspace={() => setPreviewInUrl("workspace")}
        onRetryDownload={() => {
          setSimPaused(false);
          bootstrapSim.restart();
        }}
      />
    );
  };

  if (previewMode === "all") {
    return (
      <>
        {previewOverlay}
        <PreviewGalleryPage
          scenes={{
            welcome: renderPreviewScene("welcome"),
            download: renderPreviewScene("download"),
            initialize: renderPreviewScene("initialize"),
            complete: renderPreviewScene("complete"),
            workspace: renderPreviewScene("workspace"),
          }}
        />
      </>
    );
  }

  if (previewMode !== "live") {
    return (
      <>
        {previewOverlay}
        {renderPreviewScene(previewMode)}
      </>
    );
  }

  if (!bootstrapState) {
    return (
      <main className="splash-screen">
        <IconVocaLogo height={48} />
        <div className="splash-loader" />
      </main>
    );
  }

  const activeView: AppView = (() => {
    const modelReady = bootstrapState.modelReady;
    const inRepairMode = Boolean(bootstrapState.needsRepair) && !modelReady;
    const bootstrapTaskStatus = bootstrapDownloadTask?.status;

    if (!bootstrapState.isFirstLaunch && !inRepairMode) {
      return "workspace";
    }

    if (bootstrapStartRequested && !modelReady) {
      return "download";
    }

    if (bootstrapTaskStatus === "queued" || bootstrapTaskStatus === "running" || bootstrapTaskStatus === "failed") {
      return "download";
    }

    if (bootstrapTaskStatus === "succeeded") {
      return completionAcknowledged ? "workspace" : "complete";
    }

    if (bootstrapState.phase === "ready") {
      if (!completionAcknowledged) {
        return "complete";
      }

      return "workspace";
    }

    if (initializeRequested || bootstrapState.phase === "env_check" || bootstrapState.phase === "runtime_download") {
      return "initialize";
    }

    if (bootstrapState.phase === "welcome") {
      return "welcome";
    }

    if (bootstrapState.phase === "model_download" || bootstrapState.phase === "failed") {
      return "download";
    }

    if (!modelReady) {
      return "welcome";
    }

    return "welcome";
  })();

  const handleStartSetup = () => {
    setInitializeRequested(true);
    void refreshSetupDiagnostics();
    void refreshBootstrapState();
  };

  const handleContinueFromInitialize = () => {
    const modelReady = bootstrapState.modelReady;
    if (!canContinueFromInitialize || modelReady || !isTaskTerminal(bootstrapDownloadTask)) {
      return;
    }

    setBootstrapStartRequested(true);
    setBootstrapState((current) =>
      current
        ? {
            ...current,
            phase: "model_download",
            status: "running",
            runtimeReady: sidecarStatus.running,
            sidecarReady: sidecarStatus.healthy,
            modelReady: false,
            currentDownloadJobId: null,
            lastError: null,
          }
        : current,
    );
    void refreshBootstrapState();
  };

  const handleRetryBootstrapDownload = () => {
    setBootstrapStartRequested(true);
    void refreshBootstrapState();
  };

  const handleLegacyAsrMigration = async () => {
    if (legacyAsrMigrationState === "cleaning") {
      return;
    }
    setLegacyAsrMigrationState("cleaning");
    try {
      await cleanupLegacyAsrModel();
      const info = await getServiceInfo();
      setServiceInfo(info);
      // If the new ONNX model is not yet installed, kick off the bootstrap
      // download flow so the user lands on the familiar progress screen.
      if (info && !info.asrModelReady) {
        setBootstrapStartRequested(true);
      }
      setLegacyAsrMigrationState("idle");
    } catch (error) {
      console.error("Failed to clean up legacy ASR model", error);
      setLegacyAsrMigrationState("failed");
    }
  };

  const legacyAsrMigrationVisible = Boolean(serviceInfo?.legacyAsrModelPresent);
  const legacyAsrOverlay = legacyAsrMigrationVisible ? (
    <LegacyAsrMigrationModal
      state={legacyAsrMigrationState}
      needsRedownload={!(serviceInfo?.asrModelReady ?? false)}
      onConfirm={handleLegacyAsrMigration}
    />
  ) : null;

  // The legacy-ASR migration dialog is blocking and takes precedence over
  // the (informational) auto-update notice — we don't want to stack two
  // overlays on top of each other.
  const autoUpdateOverlay =
    autoUpdateModal.mounted && autoUpdateResult && !legacyAsrMigrationVisible ? (
      <UpdateAvailableModal
        result={autoUpdateResult}
        closing={autoUpdateModal.closing}
        onClose={() => autoUpdateModal.requestClose(() => setAutoUpdateResult(null))}
      />
    ) : null;

  const globalOverlays = (
    <>
      {legacyAsrOverlay}
      {autoUpdateOverlay}
    </>
  );

  const bootstrapModel =
    modelCatalog.find(
      (model) =>
        model.modelKey ===
        (bootstrapDownloadTask?.result?.modelKey ?? preparedModel?.modelKey ?? DEFAULT_BOOTSTRAP_MODEL_KEY),
    ) ??
    modelCatalog.find((model) => model.modelKey === DEFAULT_BOOTSTRAP_MODEL_KEY) ??
    null;

  if (activeView === "welcome") {
    return (
      <>
        {previewOverlay}
        <BootstrapFlowPage
          view="welcome"
          bootstrapState={bootstrapState}
          providerRecommendation={providerRecommendation}
          preparedModel={preparedModel}
          sidecarStatus={sidecarStatus}
          serviceInfo={serviceInfo}
          onStartSetup={handleStartSetup}
        />
        {globalOverlays}
      </>
    );
  }

  if (activeView === "download") {
    return (
      <>
        {previewOverlay}
        <BootstrapFlowPage
          view="download"
          bootstrapState={bootstrapState}
          providerRecommendation={providerRecommendation}
          preparedModel={preparedModel}
          sidecarStatus={sidecarStatus}
          serviceInfo={serviceInfo}
          downloadTask={bootstrapDownloadTask}
          bootstrapModel={bootstrapModel}
          onRetryDownload={handleRetryBootstrapDownload}
        />
        {globalOverlays}
      </>
    );
  }

  if (activeView === "initialize") {
    return (
      <>
        {previewOverlay}
        <BootstrapFlowPage
          view="initialize"
          bootstrapState={bootstrapState}
          providerRecommendation={providerRecommendation}
          preparedModel={preparedModel}
          sidecarStatus={sidecarStatus}
          serviceInfo={serviceInfo}
          setupDiagnostics={setupDiagnostics}
          canProceedFromInitialize={canContinueFromInitialize}
          onProceedFromInitialize={handleContinueFromInitialize}
        />
        {globalOverlays}
      </>
    );
  }

  if (activeView === "complete") {
    return (
      <>
        {previewOverlay}
        <BootstrapFlowPage
          view="complete"
          bootstrapState={bootstrapState}
          providerRecommendation={providerRecommendation}
          preparedModel={preparedModel}
          sidecarStatus={sidecarStatus}
          serviceInfo={serviceInfo}
          bootstrapModel={bootstrapModel}
          onEnterWorkspace={async () => {
            await completeOnboarding();
            setCompletionAcknowledged(true);
          }}
        />
        {globalOverlays}
      </>
    );
  }

  return (
    <>
      {previewOverlay}
      <WorkspacePage
        bootstrapState={bootstrapState}
        sidecarStatus={sidecarStatus}
        providerRecommendation={providerRecommendation}
        preparedModel={preparedModel}
        modelCatalog={modelCatalog}
        downloadedModelCatalog={downloadedModelCatalog}
        auxiliaryModelCatalog={auxiliaryModelCatalog}
        downloadedAuxiliaryModelCatalog={downloadedAuxiliaryModelCatalog}
        serviceInfo={serviceInfo}
        storageInfo={storageInfo}
        sessionTasks={sessionTasks}
        works={works}
        worksTotal={worksTotal}
        onRefreshWorks={refreshWorks}
        onPrepareModel={handlePrepareModel}
        onSubmitTask={handleSubmitTask}
        onRefreshStorageInfo={refreshStorageInfo}
        onCacheCleared={handleCacheCleared}
      />
      {globalOverlays}
    </>
  );
}

export default App;
