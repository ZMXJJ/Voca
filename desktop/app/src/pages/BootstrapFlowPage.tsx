import type {
  BootstrapState,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "../components/StatusBadge";

type BootstrapFlowView = "welcome" | "download" | "initialize" | "complete";

type BootstrapFlowPageProps = {
  view: BootstrapFlowView;
  bootstrapState: BootstrapState;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  sidecarStatus: SidecarStatus;
  onStartSetup?: () => void;
  onEnterWorkspace?: () => void;
};

type EngineStepTone = "done" | "active" | "pending" | "danger";

const phaseProgress: Record<BootstrapState["phase"], number> = {
  welcome: 8,
  env_check: 18,
  runtime_download: 36,
  model_download: 68,
  asset_verify: 82,
  warmup: 92,
  ready: 100,
  failed: 74,
};

function getDownloadCopy(
  bootstrapState: BootstrapState,
  preparedModel: ModelPrepareResponse | null,
  t: (key: string) => string,
) {
  if (bootstrapState.phase === "runtime_download") {
    return {
      eyebrow: t("bootstrap.download.runtimeEyebrow"),
      title: t("bootstrap.download.runtimeTitle"),
      description: t("bootstrap.download.runtimeDescription"),
      activeTask: t("bootstrap.download.runtimeActiveTask"),
      detail: t("bootstrap.download.runtimeDetail"),
    };
  }

  return {
    eyebrow: t("bootstrap.download.modelEyebrow"),
    title: t("bootstrap.download.modelTitle"),
    description: t("bootstrap.download.modelDescription"),
    activeTask: preparedModel?.modelKey ?? t("bootstrap.download.modelActiveTaskFallback"),
    detail: preparedModel?.modelPath ?? t("bootstrap.download.modelDetailFallback"),
  };
}

function getEngineSteps(
  bootstrapState: BootstrapState,
  sidecarStatus: SidecarStatus,
  t: (key: string) => string,
): Array<{ title: string; detail: string; tone: EngineStepTone }> {
  let activeIndex = 0;
  let completedThrough = -1;

  switch (bootstrapState.phase) {
    case "welcome":
    case "env_check":
      activeIndex = 0;
      break;
    case "asset_verify":
      activeIndex = 1;
      completedThrough = 0;
      break;
    case "warmup":
      activeIndex = sidecarStatus.healthy || bootstrapState.sidecarReady ? 3 : 2;
      completedThrough = sidecarStatus.healthy || bootstrapState.sidecarReady ? 2 : 1;
      break;
    case "ready":
      activeIndex = 3;
      completedThrough = 3;
      break;
    case "failed":
      activeIndex = sidecarStatus.running ? 3 : bootstrapState.modelReady ? 2 : 1;
      completedThrough = bootstrapState.runtimeReady ? 0 : -1;
      break;
    default:
      activeIndex = 0;
  }

  const steps = [
    {
      title: t("bootstrap.initialize.steps.environmentTitle"),
      detail: t("bootstrap.initialize.steps.environmentDetail"),
    },
    {
      title: t("bootstrap.initialize.steps.verifyTitle"),
      detail: t("bootstrap.initialize.steps.verifyDetail"),
    },
    {
      title: t("bootstrap.initialize.steps.startTitle"),
      detail: sidecarStatus.healthy
        ? t("bootstrap.initialize.steps.startDetailHealthy")
        : t("bootstrap.initialize.steps.startDetailStarting"),
    },
    {
      title: t("bootstrap.initialize.steps.warmupTitle"),
      detail:
        bootstrapState.phase === "ready"
          ? t("bootstrap.initialize.steps.warmupDetailReady")
          : t("bootstrap.initialize.steps.warmupDetailPending"),
    },
  ];

  return steps.map((step, index) => {
    let tone: EngineStepTone = "pending";

    if (index <= completedThrough) {
      tone = "done";
    } else if (index === activeIndex) {
      tone = bootstrapState.phase === "failed" ? "danger" : "active";
    }

    return {
      ...step,
      tone,
    };
  });
}

function getPhaseLabel(phase: BootstrapState["phase"], t: (key: string) => string) {
  return t(`bootstrap.phase.${phase}`);
}

export function BootstrapFlowPage({
  view,
  bootstrapState,
  providerRecommendation,
  preparedModel,
  sidecarStatus,
  onStartSetup,
  onEnterWorkspace,
}: BootstrapFlowPageProps) {
  const { t } = useTranslation();
  const activeStepIndex =
    view === "welcome" ? 0 : view === "download" ? 1 : view === "initialize" ? 2 : 3;
  const progress = phaseProgress[bootstrapState.phase];
  const downloadCopy = getDownloadCopy(bootstrapState, preparedModel, t);
  const engineSteps = getEngineSteps(bootstrapState, sidecarStatus, t);

  return (
    <main className="flow-shell">
      <header className="flow-header">
        <div className="flow-brand">
          <div className="flow-brand__mark">V</div>
          <div>
            <strong>{t("common.appName")}</strong>
            <span>{t("common.localFirstVoiceStudio")}</span>
          </div>
        </div>
        <div className="flow-header__meta">
          <StatusBadge tone={bootstrapState.phase === "failed" ? "danger" : "accent"}>
            {getPhaseLabel(bootstrapState.phase, t)}
          </StatusBadge>
        </div>
      </header>

      <section className="flow-steps" aria-label={t("bootstrap.steps.welcome")}>
        {[
          t("bootstrap.steps.welcome"),
          t("bootstrap.steps.download"),
          t("bootstrap.steps.initialize"),
          t("bootstrap.steps.enterWorkspace"),
        ].map((step, index) => (
          <div
            key={step}
            className={`flow-step ${index === activeStepIndex ? "flow-step--active" : ""} ${
              index < activeStepIndex ? "flow-step--done" : ""
            }`}
          >
            <div className="flow-step__dot">{index + 1}</div>
            <span>{step}</span>
          </div>
        ))}
      </section>

      {view === "welcome" && (
        <section className="flow-canvas flow-canvas--welcome">
          <div className="welcome-hero">
            <p className="flow-eyebrow">{t("bootstrap.welcome.eyebrow")}</p>
            <h1>{t("bootstrap.welcome.title")}</h1>
            <p>{t("bootstrap.welcome.description")}</p>
          </div>

          <div className="welcome-badges">
            <StatusBadge tone="accent">{t("bootstrap.welcome.badges.local")}</StatusBadge>
            <StatusBadge tone="success">{t("bootstrap.welcome.badges.private")}</StatusBadge>
            <StatusBadge tone="muted">{t("bootstrap.welcome.badges.setupTime")}</StatusBadge>
          </div>

          <div className="welcome-grid">
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.steps.welcome")}</span>
              <strong>{t("bootstrap.welcome.highlights.runtimeTitle")}</strong>
              <p>{t("bootstrap.welcome.highlights.runtimeBody")}</p>
            </article>
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.steps.download")}</span>
              <strong>{t("bootstrap.welcome.highlights.modelTitle")}</strong>
              <p>{t("bootstrap.welcome.highlights.modelBody")}</p>
            </article>
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.steps.initialize")}</span>
              <strong>{t("bootstrap.welcome.highlights.recoverTitle")}</strong>
              <p>{t("bootstrap.welcome.highlights.recoverBody")}</p>
            </article>
          </div>

          <div className="welcome-actions">
            <button
              className="action-button action-button--primary"
              onClick={onStartSetup}
              disabled={!onStartSetup}
            >
              {t("bootstrap.welcome.action")}
            </button>
            <p>{t("bootstrap.welcome.actionHint")}</p>
          </div>
        </section>
      )}

      {view === "download" && (
        <section className="flow-canvas">
          <div className="flow-title-block">
            <p className="flow-eyebrow">{downloadCopy.eyebrow}</p>
            <h1>{downloadCopy.title}</h1>
            <p>{downloadCopy.description}</p>
          </div>

          <div className="panel progress-card">
            <div className="progress-card__header">
              <div>
                <span className="panel-kicker">{t("bootstrap.download.currentStage")}</span>
                <h2>{downloadCopy.activeTask}</h2>
                <p>{downloadCopy.detail}</p>
              </div>
              <div className="progress-card__percent">{progress}%</div>
            </div>

            <div className="progress-bar" aria-hidden="true">
              <div className="progress-bar__fill" style={{ width: `${progress}%` }}>
                <div className="progress-bar__glint" />
              </div>
            </div>

            <div className="stats-grid">
              <article className="stat-tile">
                <span className="panel-kicker">{t("bootstrap.download.recommendedSource")}</span>
                <strong>{providerRecommendation?.current ?? preparedModel?.provider ?? t("common.auto")}</strong>
                <p>
                  {providerRecommendation?.location ??
                    t("bootstrap.download.recommendedLocationFallback")}
                </p>
              </article>
              <article className="stat-tile">
                <span className="panel-kicker">{t("bootstrap.download.runtimeStatus")}</span>
                <strong>
                  {bootstrapState.runtimeReady
                    ? t("bootstrap.download.runtimeReady")
                    : t("bootstrap.download.runtimePreparing")}
                </strong>
                <p>{t("bootstrap.download.runtimeStatusBody")}</p>
              </article>
              <article className="stat-tile">
                <span className="panel-kicker">{t("bootstrap.download.modelDirectory")}</span>
                <strong>
                  {bootstrapState.modelReady
                    ? t("bootstrap.download.modelAvailable")
                    : t("bootstrap.download.modelWaiting")}
                </strong>
                <p>{preparedModel?.modelPath ?? t("bootstrap.download.modelDirectoryFallback")}</p>
              </article>
            </div>
          </div>
        </section>
      )}

      {view === "initialize" && (
        <section className="flow-canvas">
          <div className="flow-title-block">
            <p className="flow-eyebrow">{t("bootstrap.initialize.eyebrow")}</p>
            <h1>{t("bootstrap.initialize.title")}</h1>
            <p>{t("bootstrap.initialize.description")}</p>
          </div>

          <div className="panel engine-card">
            <div className="engine-list">
              {engineSteps.map((step, index) => (
                <article
                  key={step.title}
                  className={`engine-step engine-step--${step.tone}`}
                >
                  <div className="engine-step__icon">
                    {step.tone === "done" ? "✓" : step.tone === "danger" ? "!" : index + 1}
                  </div>
                  <div className="engine-step__body">
                    <h2>{step.title}</h2>
                    <p>{step.detail}</p>
                  </div>
                  <StatusBadge
                    tone={
                      step.tone === "done"
                        ? "success"
                        : step.tone === "active"
                          ? "accent"
                          : step.tone === "danger"
                            ? "danger"
                            : "muted"
                    }
                  >
                    {step.tone === "done"
                      ? t("bootstrap.initialize.stepStatus.done")
                      : step.tone === "active"
                        ? t("bootstrap.initialize.stepStatus.active")
                        : step.tone === "danger"
                          ? t("bootstrap.initialize.stepStatus.danger")
                          : t("bootstrap.initialize.stepStatus.pending")}
                  </StatusBadge>
                </article>
              ))}
            </div>

            {bootstrapState.lastError ? (
              <div className="flow-alert flow-alert--danger">
                <strong>{bootstrapState.lastError.message ?? t("bootstrap.initialize.errorFallback")}</strong>
                <p>
                  {t("bootstrap.initialize.errorActionsLabel")}
                  {bootstrapState.lastError.actions.length > 0
                    ? ` ${bootstrapState.lastError.actions
                        .map((action) => t(`common.errorActions.${action}`))
                        .join(" / ")}`
                    : ` ${t("bootstrap.initialize.errorActionsFallback")}`}
                </p>
              </div>
            ) : (
              <div className="flow-alert">
                <strong>
                  {sidecarStatus.healthy
                    ? t("bootstrap.initialize.healthyPassed")
                    : t("bootstrap.initialize.healthyPending")}
                </strong>
                <p>{t("bootstrap.initialize.healthyNotice")}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {view === "complete" && (
        <section className="flow-canvas flow-canvas--complete">
          <div className="complete-hero">
            <div className="complete-hero__orb">◎</div>
            <p className="flow-eyebrow">{t("bootstrap.complete.eyebrow")}</p>
            <h1>{t("bootstrap.complete.title")}</h1>
            <p>{t("bootstrap.complete.description")}</p>
          </div>

          <div className="complete-grid">
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.complete.serviceStatus")}</span>
              <strong>
                {sidecarStatus.healthy
                  ? t("bootstrap.complete.serviceReady")
                  : t("bootstrap.complete.serviceWaiting")}
              </strong>
              <p>{sidecarStatus.reason ?? t("bootstrap.complete.serviceReasonFallback")} </p>
            </article>
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.complete.defaultModel")}</span>
              <strong>
                {preparedModel?.configExists
                  ? t("bootstrap.complete.modelReady")
                  : t("bootstrap.complete.modelPending")}
              </strong>
              <p>{preparedModel?.modelKey ?? "voxcpm2-default"}</p>
            </article>
            <article className="panel stat-tile">
              <span className="panel-kicker">{t("bootstrap.complete.recommendedProvider")}</span>
              <strong>{providerRecommendation?.current ?? t("common.auto")}</strong>
              <p>{providerRecommendation?.location ?? t("bootstrap.complete.recommendedProviderFallback")}</p>
            </article>
          </div>

          <div className="complete-actions">
            <button className="action-button action-button--primary" onClick={onEnterWorkspace}>
              {t("bootstrap.complete.enterWorkspace")}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
