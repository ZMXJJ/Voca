import { useMemo, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { GenerationWorkspace } from "../components/GenerationWorkspace";
import { HistoryWorkspace } from "../components/HistoryWorkspace";
import { SettingsWorkspace } from "../components/SettingsWorkspace";
import { Sidebar } from "../components/Sidebar";

type WorkspaceSection = "studio" | "history" | "settings";

type WorkspacePageProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  modelCatalog: ModelCatalogEntry[];
  serviceInfo: ServiceInfo | null;
  currentTask: TaskRecord | null;
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmitTask: (payload: GenerationParams) => Promise<void>;
};

export function WorkspacePage({
  bootstrapState,
  sidecarStatus,
  providerRecommendation,
  preparedModel,
  modelCatalog,
  serviceInfo,
  currentTask,
  taskHistory,
  onPrepareModel,
  onSubmitTask,
}: WorkspacePageProps) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("studio");

  const sectionContent = useMemo(() => {
    switch (activeSection) {
      case "history":
        return <HistoryWorkspace />;
      case "settings":
        return (
          <SettingsWorkspace
            bootstrapState={bootstrapState}
            sidecarStatus={sidecarStatus}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            modelCatalog={modelCatalog}
            serviceInfo={serviceInfo}
            taskHistory={taskHistory}
            onPrepareModel={onPrepareModel}
          />
        );
      case "studio":
      default:
        return (
          <GenerationWorkspace
            currentTask={currentTask}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            modelCatalog={modelCatalog}
            sidecarStatus={sidecarStatus}
            taskHistory={taskHistory}
            onPrepareModel={onPrepareModel}
            onSubmit={onSubmitTask}
          />
        );
    }
  }, [
    activeSection,
    bootstrapState,
    currentTask,
    modelCatalog,
    serviceInfo,
    onPrepareModel,
    onSubmitTask,
    preparedModel,
    providerRecommendation,
    sidecarStatus,
    taskHistory,
  ]);

  return (
    <main className="workspace">
      <Sidebar
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        sidecarStatus={sidecarStatus}
      />
      <div className="main-content">
        <div className="main-scroll">
          {sectionContent}
        </div>
      </div>
    </main>
  );
}
