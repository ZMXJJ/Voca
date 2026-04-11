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
import { StatusBadge } from "../components/StatusBadge";

type WorkspacePageProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  currentTask: TaskRecord | null;
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
  onPrepareModel,
  onSubmitTask,
}: WorkspacePageProps) {
  const { t } = useTranslation();

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
          <button className="workspace-nav__item workspace-nav__item--active">
            <span>{t("workspace.nav.cloning")}</span>
            <StatusBadge tone="accent">{t("workspace.nav.current")}</StatusBadge>
          </button>
          <button className="workspace-nav__item" disabled>
            <span>{t("workspace.nav.history")}</span>
            <StatusBadge tone="muted">{t("workspace.nav.nextBatch")}</StatusBadge>
          </button>
          <button className="workspace-nav__item" disabled>
            <span>{t("workspace.nav.settings")}</span>
            <StatusBadge tone="muted">{t("workspace.nav.nextBatch")}</StatusBadge>
          </button>
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
          </div>
        </header>

        <div className="workspace-content">
          <section className="workspace-hero">
            <div>
              <p className="hero-kicker">{t("workspace.hero.kicker")}</p>
              <h1 className="hero-title">{t("workspace.hero.title")}</h1>
              <p className="hero-copy">{t("workspace.hero.description")}</p>
            </div>
          </section>

          <GenerationWorkspace
            currentTask={currentTask}
            providerRecommendation={providerRecommendation}
            preparedModel={preparedModel}
            sidecarStatus={sidecarStatus}
            onPrepareModel={onPrepareModel}
            onSubmit={onSubmitTask}
          />
        </div>
      </section>
    </main>
  );
}
