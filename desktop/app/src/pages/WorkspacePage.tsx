import { useMemo, useState } from "react";
import type {
  BootstrapState,
  GenerationParams,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { GenerationWorkspace } from "../components/GenerationWorkspace";
import { HistoryWorkspace } from "../components/HistoryWorkspace";
import { SettingsWorkspace } from "../components/SettingsWorkspace";
import { StatusBadge } from "../components/StatusBadge";

type WorkspaceSection = "cloning" | "history" | "settings";

type WorkspacePageProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
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
  currentTask,
  taskHistory,
  onPrepareModel,
  onSubmitTask,
}: WorkspacePageProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("cloning");

  const sectionContent = useMemo(() => {
    switch (activeSection) {
      case "history":
        return (
          <HistoryWorkspace
            currentTask={currentTask}
            taskHistory={taskHistory}
          />
        );
      case "settings":
        return (
          <SettingsWorkspace
            bootstrapState={bootstrapState}
            sidecarStatus={sidecarStatus}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            taskHistory={taskHistory}
            onPrepareModel={onPrepareModel}
          />
        );
      case "cloning":
      default:
        return (
          <GenerationWorkspace
            currentTask={currentTask}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            sidecarStatus={sidecarStatus}
            onPrepareModel={onPrepareModel}
            onSubmit={onSubmitTask}
          />
        );
    }
  }, [
    activeSection,
    bootstrapState,
    currentTask,
    onPrepareModel,
    onSubmitTask,
    preparedModel,
    providerRecommendation,
    sidecarStatus,
    taskHistory,
  ]);

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <div className="workspace-brand__mark">V</div>
          <div>
            <strong>{t("common.appName")}</strong>
            <span>{t("common.creatorWorkspace")}</span>
          </div>
        </div>

        <nav className="workspace-nav" aria-label={t("workspace.navLabel")}>
          {(["cloning", "history", "settings"] as WorkspaceSection[]).map((section) => (
            <button
              key={section}
              className={`workspace-nav__item${activeSection === section ? " workspace-nav__item--active" : ""}`}
              onClick={() => setActiveSection(section)}
              type="button"
            >
              <span>{t(`workspace.nav.${section}`)}</span>
              <StatusBadge tone={activeSection === section ? "accent" : "muted"}>
                {activeSection === section ? t("workspace.nav.current") : t("workspace.nav.available")}
              </StatusBadge>
            </button>
          ))}
        </nav>

        <div className="workspace-sidebar__foot">
          <p>{t("workspace.sidebar.title")}</p>
          <span>{t("workspace.sidebar.body")}</span>
        </div>
      </aside>

      <section className="workspace-body">
        <header className="workspace-topbar">
          <div className="topbar-cluster">
            <StatusBadge tone={sidecarStatus.healthy ? "success" : "warning"}>
              {t("workspace.topbar.serviceLabel")}:{" "}
              {sidecarStatus.healthy ? t("workspace.topbar.ready") : t("workspace.topbar.preparing")}
            </StatusBadge>
            <StatusBadge tone={bootstrapState.modelReady ? "success" : "muted"}>
              {t("workspace.topbar.modelLabel")}:{" "}
              {bootstrapState.modelReady ? t("workspace.topbar.ready") : t("workspace.topbar.pending")}
            </StatusBadge>
          </div>

          <div className="topbar-cluster">
            <span className="topbar-note">
              {t("workspace.topbar.providerLabel")}:{" "}
              {providerRecommendation?.current ?? preparedModel?.provider ?? t("common.auto")}
            </span>
            <span className="topbar-note">
              {t("workspace.topbar.phaseLabel")}: {t(`bootstrap.phase.${bootstrapState.phase}`)}
            </span>
            <span className="topbar-note">
              {t("workspace.topbar.sectionLabel")}: {t(`workspace.nav.${activeSection}`)}
            </span>
          </div>
        </header>

        <div className="workspace-content">
          <section className="workspace-hero">
            <div>
              <p className="hero-kicker">{t(`workspace.hero.${activeSection}.kicker`)}</p>
              <h1 className="hero-title">{t(`workspace.hero.${activeSection}.title`)}</h1>
              <p className="hero-copy">{t(`workspace.hero.${activeSection}.description`)}</p>
            </div>
          </section>

          {sectionContent}
        </div>
      </section>
    </main>
  );
}
