import { useEffect, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SetupDiagnostics,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { PreviewDock } from "./components/PreviewDock";
import { loadPersistedTaskHistory, normalizeTaskHistory, savePersistedTaskHistory } from "./lib/historyStorage";
import { BootstrapFlowPage } from "./pages/BootstrapFlowPage";
import { PreviewGalleryPage } from "./pages/PreviewGalleryPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { getPreviewModeFromSearch, type PreviewMode, type SinglePreviewScene } from "./preview";
import { IconVocaLogo } from "./components/Icons";
import {
  completeOnboarding,
  createGenerateTask,
  getBootstrapState,
  getModelCatalog,
  getProviderRecommendation,
  getQuickBootstrapState,
  getServiceInfo,
  getSetupDiagnostics,
  getSidecarStatus,
  getTask,
  prepareModel,
  startBootstrapDownload,
} from "./lib/tauri";

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
    modelPath: "~/Library/Application Support/Voca/models/voxcpm2",
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

function createPreviewBootstrapDownloadTask(): TaskRecord {
  const now = new Date().toISOString();

  return {
    id: "preview-bootstrap-task",
    type: "bootstrap",
    status: "running",
    createdAt: now,
    updatedAt: now,
    title: "Prepare speech tools bundle",
    progress: 68,
    message: "Preparing SenseVoiceSmall",
    downloadProgress: {
      phase: "downloading",
      provider: "modelscope",
      currentFile: "SenseVoiceSmall",
      downloadedBytes: 560 * 1024 * 1024,
      totalBytes: 936 * 1024 * 1024,
      totalBytesComplete: true,
      completedFiles: 1,
      totalFiles: 3,
    },
    bootstrapAssetProgress: [
      {
        modelKey: "voxcpm2",
        displayName: "VoxCPM2",
        status: "succeeded",
        progress: 100,
        provider: "huggingface",
        currentFile: "VoxCPM2",
        downloadedBytes: 0,
        totalBytes: null,
        totalBytesComplete: true,
      },
      {
        modelKey: "sensevoice_small",
        displayName: "SenseVoiceSmall",
        status: "running",
        progress: 68,
        provider: "modelscope",
        currentFile: "SenseVoiceSmall",
        downloadedBytes: 560 * 1024 * 1024,
        totalBytes: 936 * 1024 * 1024,
        totalBytesComplete: true,
      },
      {
        modelKey: "zipenhancer_16k",
        displayName: "ZipEnhancer 16k",
        status: "pending",
        progress: 0,
        provider: null,
        currentFile: null,
        downloadedBytes: 0,
        totalBytes: null,
        totalBytesComplete: false,
      },
    ],
    error: null,
    result: {
      modelKey: DEFAULT_BOOTSTRAP_MODEL_KEY,
      modelPath: "~/Library/Application Support/Voca/models/voxcpm2",
      provider: "huggingface",
      completedAssets: ["voxcpm2"],
    },
  };
}

function createPreviewSetupDiagnostics(): SetupDiagnostics {
  return {
    cpuName: "Apple M4",
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    availableStorageBytes: 42_000_000_000,
    recommendedMemoryBytes: 12 * 1024 * 1024 * 1024,
    minimumFreeStorageBytes: 5_000_000_000,
    environmentReady: true,
    environmentStatus: "ready",
    environmentReason: null,
  };
}

function upsertTaskHistory(history: TaskRecord[], task: TaskRecord): TaskRecord[] {
  return normalizeTaskHistory([task, ...history.filter((item) => item.id !== task.id)]);
}

function removeTasksFromHistory(history: TaskRecord[], removedTaskIds: string[]): TaskRecord[] {
  if (removedTaskIds.length === 0) {
    return history;
  }

  const removedIdSet = new Set(removedTaskIds);
  return history.filter((item) => !removedIdSet.has(item.id));
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
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [setupDiagnostics, setSetupDiagnostics] = useState<SetupDiagnostics | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  const [bootstrapDownloadTask, setBootstrapDownloadTask] = useState<TaskRecord | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskRecord[]>(() => loadPersistedTaskHistory());
  const [completionAcknowledged, setCompletionAcknowledged] = useState(false);
  const [finalizedBootstrapTaskId, setFinalizedBootstrapTaskId] = useState<string | null>(null);
  const [initializeRequested, setInitializeRequested] = useState(false);
  const [bootstrapStartRequested, setBootstrapStartRequested] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() =>
    typeof window === "undefined" ? "live" : getPreviewModeFromSearch(window.location.search),
  );

  useEffect(() => {
    const handlePopState = () => {
      setPreviewMode(getPreviewModeFromSearch(window.location.search));
    };

    window.addEventListener("popstate", handlePopState);

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const refreshModelCatalogState = async () => {
    const catalog = await getModelCatalog();
    const ttsCatalog = catalog.filter((entry) => entry.assetRole === "tts");
    setModelCatalog(ttsCatalog);

    const preparedEntries = await Promise.all(
      ttsCatalog.map(async (entry) => ({
        entry,
        prepared: await prepareModel(entry.modelKey, "auto", false),
      })),
    );

    setDownloadedModelCatalog(
      preparedEntries
        .filter(({ prepared }) => prepared?.configExists)
        .map(({ entry }) => entry),
    );
  };

  const refreshServiceInfo = async () => {
    const info = await getServiceInfo();
    setServiceInfo(info);
  };

  const refreshSetupDiagnostics = async () => {
    const diagnostics = await getSetupDiagnostics();
    setSetupDiagnostics(diagnostics);
  };

  const refreshBootstrapState = async () => {
    const [bs, ss] = await Promise.all([getBootstrapState(), getSidecarStatus()]);
    setBootstrapState(bs);
    setSidecarStatus(ss);
    if (ss.healthy && bs.currentDownloadJobId) {
      void getTask(bs.currentDownloadJobId).then((task) => setBootstrapDownloadTask(task));
    } else {
      setBootstrapDownloadTask((current) => {
        if (!current) {
          return null;
        }
        return ["queued", "running", "failed", "cancelled"].includes(current.status) ? current : null;
      });
    }
    if (ss.healthy) {
      void getProviderRecommendation("auto").then(setProviderRecommendation);
      void prepareModel(DEFAULT_BOOTSTRAP_MODEL_KEY, "auto", false).then(setPreparedModel);
      void refreshModelCatalogState();
      void refreshServiceInfo();
    }
  };

  useEffect(() => {
    void getQuickBootstrapState().then((quickState) => {
      setBootstrapState(quickState);
      void refreshBootstrapState();
    });
  }, []);

  useEffect(() => {
    if (sidecarStatus.healthy) return;
    const timer = window.setInterval(() => {
      void refreshBootstrapState();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sidecarStatus.healthy]);

  useEffect(() => {
    if (!sidecarStatus.healthy) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshServiceInfo();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [sidecarStatus.healthy]);

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

  useEffect(() => {
    savePersistedTaskHistory(taskHistory);
  }, [taskHistory]);

  useEffect(() => {
    if (!currentTask || ["succeeded", "failed", "cancelled"].includes(currentTask.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void getTask(currentTask.id).then((task) => {
        if (task) {
          setCurrentTask(task);
          setTaskHistory((history) => upsertTaskHistory(history, task));
        }
      });
    }, 600);

    return () => window.clearInterval(timer);
  }, [currentTask]);

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
        const prepared = await prepareModel(
          bootstrapDownloadTask.result?.modelKey ?? DEFAULT_BOOTSTRAP_MODEL_KEY,
          "auto",
          false,
        );
        setPreparedModel(prepared);
        await refreshModelCatalogState();
        await refreshBootstrapState();
      })();
      return;
    }

    if (bootstrapDownloadTask.status === "failed" || bootstrapDownloadTask.status === "cancelled") {
      void refreshBootstrapState();
    }
  }, [bootstrapDownloadTask, finalizedBootstrapTaskId]);

  useEffect(() => {
    if (!bootstrapStartRequested) {
      return;
    }

    const modelReady = serviceInfo?.bootstrapAssetsReady ?? bootstrapState?.modelReady ?? false;
    if (modelReady || !bootstrapState?.isFirstLaunch) {
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
    serviceInfo?.bootstrapAssetsReady,
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
    setCurrentTask(task);
    setTaskHistory((history) => upsertTaskHistory(history, task));
  };

  const handleCacheCleared = (
    nextServiceInfo: ServiceInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
  ) => {
    if (removedTaskIds.length > 0) {
      const removedIdSet = new Set(removedTaskIds);
      setTaskHistory((history) => removeTasksFromHistory(history, removedTaskIds));
      setCurrentTask((task) => (task && removedIdSet.has(task.id) ? null : task));
    }

    setServiceInfo((info) => nextServiceInfo ?? (info ? { ...info, cacheBytes: remainingBytes } : info));
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
      {import.meta.env.DEV && <PreviewDock mode={previewMode} onChange={setPreviewInUrl} />}
    </>
  );

  const previewRecommendation = providerRecommendation ?? fallbackProviderRecommendation;
  const previewTask = createPreviewTask(currentTask);
  const previewBootstrapDownloadTask = createPreviewBootstrapDownloadTask();
  const previewSetupDiagnostics = createPreviewSetupDiagnostics();
  const previewTaskHistory = taskHistory.length > 0 ? upsertTaskHistory(taskHistory, previewTask) : [previewTask];
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
          serviceInfo={serviceInfo}
          currentTask={previewTask}
          taskHistory={previewTaskHistory}
          onPrepareModel={handlePrepareModel}
          onSubmitTask={handleSubmitTask}
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
        downloadTask={scene === "download" ? previewBootstrapDownloadTask : null}
        bootstrapModel={previewBootstrapModel}
        onStartSetup={() => setPreviewInUrl("initialize")}
        onProceedFromInitialize={() => setPreviewInUrl("download")}
        canProceedFromInitialize={scene === "initialize" ? true : canContinueFromInitialize}
        onEnterWorkspace={() => setPreviewInUrl("workspace")}
        onRetryDownload={() => setPreviewInUrl("download")}
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
    if (!bootstrapState.isFirstLaunch) {
      return "workspace";
    }

    const modelReady = serviceInfo?.bootstrapAssetsReady ?? bootstrapState.modelReady;
    const bootstrapTaskStatus = bootstrapDownloadTask?.status;

    if (bootstrapStartRequested && !modelReady) {
      return "download";
    }

    if (bootstrapTaskStatus === "queued" || bootstrapTaskStatus === "running" || bootstrapTaskStatus === "failed") {
      return "download";
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

  const canContinueFromInitialize = Boolean(
    setupDiagnostics &&
      setupDiagnostics.environmentReady &&
      (setupDiagnostics.availableStorageBytes ?? 0) >= setupDiagnostics.minimumFreeStorageBytes,
  );

  const handleStartSetup = () => {
    setInitializeRequested(true);
    void refreshSetupDiagnostics();
    void refreshBootstrapState();
  };

  const handleContinueFromInitialize = () => {
    const modelReady = serviceInfo?.bootstrapAssetsReady ?? bootstrapState.modelReady;
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
        serviceInfo={serviceInfo}
        currentTask={currentTask}
        taskHistory={taskHistory}
        onPrepareModel={handlePrepareModel}
        onSubmitTask={handleSubmitTask}
        onCacheCleared={handleCacheCleared}
      />
    </>
  );
}

export default App;
