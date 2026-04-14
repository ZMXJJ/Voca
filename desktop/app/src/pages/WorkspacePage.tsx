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
  downloadedModelCatalog: ModelCatalogEntry[];
  auxiliaryModelCatalog: ModelCatalogEntry[];
  downloadedAuxiliaryModelCatalog: ModelCatalogEntry[];
  serviceInfo: ServiceInfo | null;
  currentTask: TaskRecord | null;
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmitTask: (payload: GenerationParams) => Promise<void>;
  onCacheCleared: (
    serviceInfo: ServiceInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => void;
};

export function WorkspacePage({
  bootstrapState,
  sidecarStatus,
  providerRecommendation,
  preparedModel,
  modelCatalog,
  downloadedModelCatalog,
  auxiliaryModelCatalog,
  downloadedAuxiliaryModelCatalog,
  serviceInfo,
  currentTask,
  taskHistory,
  onPrepareModel,
  onSubmitTask,
  onCacheCleared,
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
            downloadedModelCatalog={downloadedModelCatalog}
            auxiliaryModelCatalog={auxiliaryModelCatalog}
            downloadedAuxiliaryModelCatalog={downloadedAuxiliaryModelCatalog}
            serviceInfo={serviceInfo}
            taskHistory={taskHistory}
            onPrepareModel={onPrepareModel}
            onCacheCleared={onCacheCleared}
          />
        );
      case "studio":
      default:
        return (
          <GenerationWorkspace
            currentTask={currentTask}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            modelCatalog={downloadedModelCatalog}
            sidecarStatus={sidecarStatus}
            taskHistory={taskHistory}
            onPrepareModel={onPrepareModel}
            onSubmit={onSubmitTask}
          />
        );
    }
  }, [
    activeSection,
    auxiliaryModelCatalog,
    bootstrapState,
    currentTask,
    downloadedAuxiliaryModelCatalog,
    downloadedModelCatalog,
    modelCatalog,
    serviceInfo,
    onPrepareModel,
    onSubmitTask,
    onCacheCleared,
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
        serviceInfo={serviceInfo}
      />
      <div className="main-content">
        <div className="main-scroll">
          {sectionContent}
        </div>
      </div>
    </main>
  );
}
