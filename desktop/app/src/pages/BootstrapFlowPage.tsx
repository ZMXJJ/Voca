import type {
  BootstrapState,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { IconArrowRight, IconCheck, IconVocaLogo } from "../components/Icons";
import { StepIndicator } from "../components/StepIndicator";

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

type StepStatus = "done" | "active" | "pending";

function getFlowSteps(view: BootstrapFlowView, t: (key: string) => string) {
  const map: Record<BootstrapFlowView, [StepStatus, StepStatus, StepStatus]> = {
    welcome: ["active", "pending", "pending"],
    initialize: ["active", "pending", "pending"],
    download: ["done", "active", "pending"],
    complete: ["done", "done", "active"],
  };
  const statuses = map[view];
  return [
    { label: t("bootstrap.flow.step1"), status: statuses[0] },
    { label: t("bootstrap.flow.step2"), status: statuses[1] },
    { label: t("bootstrap.flow.step3"), status: statuses[2] },
  ];
}

function getEngineSteps(
  bootstrapState: BootstrapState,
  sidecarStatus: SidecarStatus,
  t: (key: string) => string,
) {
  let completedThrough = -1;
  let activeIndex = 0;

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

  const items = [
    { title: t("bootstrap.init.checkEnv"), desc: t("bootstrap.init.checkEnvDesc") },
    { title: t("bootstrap.init.checkNet"), desc: t("bootstrap.init.checkNetDesc") },
    { title: t("bootstrap.init.installDeps"), desc: t("bootstrap.init.installDepsDesc") },
    { title: t("bootstrap.init.startService"), desc: t("bootstrap.init.startServiceDesc") },
  ];

  return items.map((item, index) => {
    let status: "done" | "active" | "pending" = "pending";
    if (index <= completedThrough) status = "done";
    else if (index === activeIndex) status = "active";
    return { ...item, status };
  });
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
  const progress = phaseProgress[bootstrapState.phase];

  if (view === "welcome") {
    return (
      <main className="welcome-page">
        <div className="welcome-page__logo"><IconVocaLogo height={40} /></div>
        <h1 className="welcome-page__title">{t("bootstrap.welcome.headline")}</h1>
        <p className="welcome-page__subtitle">{t("bootstrap.welcome.subtitle")}</p>
        <div className="welcome-page__action">
          <button className="btn btn--glass" onClick={onStartSetup} disabled={!onStartSetup}>
            {t("bootstrap.welcome.startBtn")}
            <IconArrowRight size={15} />
          </button>
        </div>
        <p className="welcome-page__hint">{t("bootstrap.welcome.hint")}</p>
      </main>
    );
  }

  const steps = getFlowSteps(view, t);

  return (
    <main className="bootstrap-page">
      <header className="bootstrap-page__header">
        <div className="bootstrap-page__logo"><IconVocaLogo height={24} /></div>
        <div className="bootstrap-page__steps">
          <StepIndicator steps={steps} />
        </div>
      </header>

      <div className="bootstrap-page__body">
        {view === "initialize" && (
          <>
            <h1 className="bootstrap-page__title">{t("bootstrap.init.title")}</h1>
            <p className="bootstrap-page__desc">{t("bootstrap.init.desc")}</p>
            <div className="bootstrap-page__content">
              <div className="steps-card">
                {getEngineSteps(bootstrapState, sidecarStatus, t).map((step, index) => (
                  <div key={step.title} className="steps-card__item">
                    <div className={`steps-card__icon steps-card__icon--${step.status}`}>
                      {step.status === "done" ? <IconCheck size={14} /> : index + 1}
                    </div>
                    <div className="steps-card__info">
                      <div className="steps-card__info-title">{step.title}</div>
                      <div className="steps-card__info-desc">{step.desc}</div>
                    </div>
                    <span className={`steps-card__status steps-card__status--${step.status}`}>
                      {step.status === "done"
                        ? t("bootstrap.init.statusDone")
                        : step.status === "active"
                          ? t("bootstrap.init.statusActive")
                          : t("bootstrap.init.statusPending")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {view === "download" && (
          <>
            <h1 className="bootstrap-page__title">{t("bootstrap.download.title")}</h1>
            <p className="bootstrap-page__desc">{t("bootstrap.download.desc")}</p>
            <div className="bootstrap-page__content">
              <div className="progress-card">
                <div className="progress-card__top">
                  <span className="progress-card__model-name">
                    {preparedModel?.modelKey ?? "VoxCPM 2.0"}
                  </span>
                  <span className="progress-card__percent">{progress}%</span>
                </div>
                <div className="progress-card__bar">
                  <div className="progress-card__fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="progress-card__stats">
                  <div className="progress-card__stat">
                    <div className="progress-card__stat-label">{t("bootstrap.download.source")}</div>
                    <div className="progress-card__stat-value">
                      {providerRecommendation?.current === "modelscope"
                        ? "ModelScope"
                        : providerRecommendation?.current === "huggingface"
                          ? "HuggingFace"
                          : t("common.auto")}
                    </div>
                  </div>
                  <div className="progress-card__stat">
                    <div className="progress-card__stat-label">{t("bootstrap.download.modelSize")}</div>
                    <div className="progress-card__stat-value">~2.3 GB</div>
                  </div>
                  <div className="progress-card__stat">
                    <div className="progress-card__stat-label">{t("bootstrap.download.storageDir")}</div>
                    <div className="progress-card__stat-value">
                      {preparedModel?.modelPath ?? "~/Voca/models"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {view === "complete" && (
          <>
            <h1 className="bootstrap-page__title">{t("bootstrap.complete.title")}</h1>
            <p className="bootstrap-page__desc">{t("bootstrap.complete.desc")}</p>
            <div className="bootstrap-page__content">
              <div className="summary-cards">
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.serviceLabel")}</div>
                  <div className="summary-card__value summary-card__value--green">
                    {sidecarStatus.healthy
                      ? <><IconCheck size={14} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />{t("bootstrap.complete.serviceReady")}</>
                      : t("bootstrap.complete.serviceWaiting")}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.modelLabel")}</div>
                  <div className="summary-card__value">
                    {preparedModel?.modelKey ?? "VoxCPM 2.0"}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.deviceLabel")}</div>
                  <div className="summary-card__value">MPS (Apple Silicon)</div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {(view === "initialize" || view === "download") && (
        <div className="bootstrap-page__footer">
          <button className="btn btn--glass" disabled>
            {t("bootstrap.flow.nextBtn")}
            <IconArrowRight size={12} />
          </button>
        </div>
      )}

      {view === "complete" && (
        <div className="bootstrap-page__footer">
          <button className="btn btn--glass" onClick={onEnterWorkspace}>
            {t("bootstrap.complete.enterBtn")}
            <IconArrowRight size={13} />
          </button>
        </div>
      )}
    </main>
  );
}
