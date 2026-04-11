import { useEffect, useState } from "react";
import type {
  BootstrapState,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { HomePage } from "./pages/HomePage";
import {
  createGenerateTask,
  getBootstrapState,
  getProviderRecommendation,
  getSidecarStatus,
  getTask,
  prepareModel,
} from "./lib/tauri";

function App() {
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>({
    running: false,
    healthy: false,
    reason: "loading",
  });
  const [providerRecommendation, setProviderRecommendation] = useState<ProviderRecommendation | null>(null);
  const [preparedModel, setPreparedModel] = useState<ModelPrepareResponse | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);

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

  if (!bootstrapState) {
    return <main className="loading-screen">正在加载 Voca 桌面骨架...</main>;
  }

  return (
    <HomePage
      bootstrapState={bootstrapState}
      sidecarStatus={sidecarStatus}
      providerRecommendation={providerRecommendation}
      preparedModel={preparedModel}
      currentTask={currentTask}
      onPrepareModel={async (modelKey, providerPreference, ensureDownloaded) => {
        const recommendation = await getProviderRecommendation(providerPreference);
        setProviderRecommendation(recommendation);
        const prepared = await prepareModel(modelKey, providerPreference, ensureDownloaded);
        setPreparedModel(prepared);
      }}
      onSubmitTask={async (payload) => {
        const task = await createGenerateTask(payload);
        setCurrentTask(task);
      }}
    />
  );
}

export default App;
