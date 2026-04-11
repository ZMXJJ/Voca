import { useEffect, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { PreviewDock } from "./components/PreviewDock";
import { BootstrapFlowPage } from "./pages/BootstrapFlowPage";
import { PreviewGalleryPage } from "./pages/PreviewGalleryPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { getPreviewModeFromSearch, type PreviewMode, type SinglePreviewScene } from "./preview";
import {
  createGenerateTask,
  getBootstrapState,
  getProviderRecommendation,
  getSidecarStatus,
  getTask,
  prepareModel,
} from "./lib/tauri";

type AppView = "loading" | "welcome" | "download" | "initialize" | "complete" | "workspace";

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
    modelKey: "voxcpm2-default",
    modelPath: "~/Library/Application Support/Voca/models/voxcpm2-default",
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

function App() {
  const { t } = useTranslation();
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>({
    running: false,
    healthy: false,
    reason: "loading",
  });
  const [providerRecommendation, setProviderRecommendation] = useState<ProviderRecommendation | null>(null);
  const [preparedModel, setPreparedModel] = useState<ModelPrepareResponse | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  const [completionAcknowledged, setCompletionAcknowledged] = useState(false);
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

  useEffect(() => {
    void getBootstrapState().then(setBootstrapState);
    void getSidecarStatus().then(setSidecarStatus);
    void getProviderRecommendation("auto").then(setProviderRecommendation);
    void prepareModel("voxcpm2-default", "auto", false).then(setPreparedModel);
  }, []);

  useEffect(() => {
    if (!currentTask || ["succeeded", "failed", "cancelled"].includes(currentTask.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void getTask(currentTask.id).then((task) => {
        if (task) {
          setCurrentTask(task);
        }
      });
    }, 600);

    return () => window.clearInterval(timer);
  }, [currentTask]);

  const handlePrepareModel = async (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => {
    const recommendation = await getProviderRecommendation(providerPreference);
    setProviderRecommendation(recommendation);
    const prepared = await prepareModel(modelKey, providerPreference, ensureDownloaded);
    setPreparedModel(prepared);
  };

  const handleSubmitTask = async (payload: GenerationParams) => {
    const task = await createGenerateTask(payload);
    setCurrentTask(task);
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
      <LanguageSwitcher />
      {import.meta.env.DEV && <PreviewDock mode={previewMode} onChange={setPreviewInUrl} />}
    </>
  );

  const previewRecommendation = providerRecommendation ?? fallbackProviderRecommendation;
  const previewTask = createPreviewTask(currentTask);
  const renderPreviewScene = (scene: SinglePreviewScene) => {
    const previewBootstrapState = createPreviewBootstrapState(bootstrapState ?? fallbackBootstrapState, scene);
    const previewSidecarStatus = createPreviewSidecarStatus(sidecarStatus, scene);
    const previewPreparedModel = createPreviewPreparedModel(preparedModel, previewRecommendation, scene);

    if (scene === "workspace") {
      return (
        <WorkspacePage
          bootstrapState={previewBootstrapState}
          sidecarStatus={previewSidecarStatus}
          providerRecommendation={previewRecommendation}
          preparedModel={previewPreparedModel}
          currentTask={previewTask}
          onPrepareModel={handlePrepareModel}
          onSubmitTask={handleSubmitTask}
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
        onStartSetup={() => setPreviewInUrl("download")}
        onEnterWorkspace={() => setPreviewInUrl("workspace")}
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
      <>
        {previewOverlay}
        <main className="loading-screen">
          <section className="loading-card">
            <p className="flow-eyebrow">{t("loading.eyebrow")}</p>
            <h1>{t("loading.title")}</h1>
            <p>{t("loading.description")}</p>
          </section>
        </main>
      </>
    );
  }

  const activeView: AppView = (() => {
    if (bootstrapState.phase === "welcome") {
      return "welcome";
    }

    if (bootstrapState.phase === "runtime_download" || bootstrapState.phase === "model_download") {
      return "download";
    }

    if (bootstrapState.phase === "ready") {
      if (bootstrapState.isFirstLaunch && !completionAcknowledged) {
        return "complete";
      }

      return "workspace";
    }

    return "initialize";
  })();

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
          onEnterWorkspace={() => setCompletionAcknowledged(true)}
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
        currentTask={currentTask}
        onPrepareModel={handlePrepareModel}
        onSubmitTask={handleSubmitTask}
      />
    </>
  );
}

export default App;
