import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SidecarStatus,
  StorageInfo,
  TaskRecord,
  VoiceEntry,
  WorkEntry,
} from "@voca/contracts";
import { GenerationWorkspace } from "../components/GenerationWorkspace";
import { HistoryWorkspace } from "../components/HistoryWorkspace";
import { SettingsWorkspace } from "../components/SettingsWorkspace";
import { Sidebar } from "../components/Sidebar";
import { listVoices } from "../lib/tauri";

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
  storageInfo: StorageInfo | null;
  sessionTasks: TaskRecord[];
  works: WorkEntry[];
  worksTotal: number;
  onRefreshWorks: () => Promise<void>;
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmitTask: (payload: GenerationParams) => Promise<void>;
  onRefreshStorageInfo: () => Promise<void>;
  onCacheCleared: (
    storageInfo: StorageInfo | null,
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
  storageInfo,
  sessionTasks,
  works,
  worksTotal,
  onRefreshWorks,
  onPrepareModel,
  onSubmitTask,
  onRefreshStorageInfo,
  onCacheCleared,
}: WorkspacePageProps) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("studio");
  // Generation params carried from the works library's "reuse" action into
  // the Studio composer. Consumed (and cleared) by GenerationWorkspace once
  // the form fields have been prefilled.
  const [studioPrefill, setStudioPrefill] = useState<GenerationParams | null>(null);

  // The voice library is loaded once at this level (instead of inside
  // ``GenerationWorkspace``) so switching between Studio / Library / Settings
  // — which unmounts and remounts the section components — does not refetch
  // the voice list every time. Re-pulling on every tab switch was the
  // dominant source of "voices take a few seconds to show" on Windows
  // because each ``listVoices`` call goes through the sidecar health probe.
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);

  const loadVoices = useCallback(async () => {
    const nextVoices = await listVoices();
    setVoices(nextVoices);
    setSelectedVoiceId((current) => {
      if (current && nextVoices.some((voice) => voice.id === current)) return current;
      return nextVoices[0]?.id ?? null;
    });
    return nextVoices;
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const handleReuseParams = useCallback((params: GenerationParams) => {
    setStudioPrefill(params);
    setActiveSection("studio");
  }, []);

  const handlePrefillConsumed = useCallback(() => {
    setStudioPrefill(null);
  }, []);

  const sectionContent = useMemo(() => {
    switch (activeSection) {
      case "history":
        return (
          <HistoryWorkspace
            works={works}
            voices={voices}
            onWorksChanged={onRefreshWorks}
            onReuseParams={handleReuseParams}
          />
        );
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
            storageInfo={storageInfo}
            worksTotal={worksTotal}
            onPrepareModel={onPrepareModel}
            onRefreshStorageInfo={onRefreshStorageInfo}
            onCacheCleared={onCacheCleared}
          />
        );
      case "studio":
      default:
        return (
          <GenerationWorkspace
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            modelCatalog={downloadedModelCatalog}
            sidecarStatus={sidecarStatus}
            sessionTasks={sessionTasks}
            works={works}
            voices={voices}
            selectedVoiceId={selectedVoiceId}
            prefill={studioPrefill}
            onPrefillConsumed={handlePrefillConsumed}
            onSelectVoice={setSelectedVoiceId}
            onReloadVoices={loadVoices}
            onPrepareModel={onPrepareModel}
            onSubmit={onSubmitTask}
          />
        );
    }
  }, [
    activeSection,
    auxiliaryModelCatalog,
    bootstrapState,
    downloadedAuxiliaryModelCatalog,
    downloadedModelCatalog,
    handlePrefillConsumed,
    handleReuseParams,
    loadVoices,
    modelCatalog,
    onCacheCleared,
    onPrepareModel,
    onRefreshStorageInfo,
    onRefreshWorks,
    onSubmitTask,
    preparedModel,
    providerRecommendation,
    selectedVoiceId,
    serviceInfo,
    sessionTasks,
    sidecarStatus,
    storageInfo,
    studioPrefill,
    voices,
    works,
    worksTotal,
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
