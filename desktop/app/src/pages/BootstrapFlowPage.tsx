import type {
  BootstrapState,
  BootstrapAssetDownloadProgress,
  BootstrapAssetStatus,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SetupDiagnostics,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { IconAlert, IconArrowRight, IconCheck, IconVocaLogo } from "../components/Icons";
import { StepIndicator } from "../components/StepIndicator";

type BootstrapFlowView = "welcome" | "download" | "initialize" | "complete";

type BootstrapFlowPageProps = {
  view: BootstrapFlowView;
  bootstrapState: BootstrapState;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  sidecarStatus: SidecarStatus;
  serviceInfo?: ServiceInfo | null;
  setupDiagnostics?: SetupDiagnostics | null;
  downloadTask?: TaskRecord | null;
  bootstrapModel?: ModelCatalogEntry | null;
  onStartSetup?: () => void;
  onProceedFromInitialize?: () => void;
  canProceedFromInitialize?: boolean;
  onEnterWorkspace?: () => void;
  onRetryDownload?: () => void;
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
type BootstrapAssetCardStatus = "pending" | "running" | "succeeded" | "failed";

type BootstrapAssetCard = {
  modelKey: string;
  displayName: string;
  localDir?: string | null;
  approxSizeLabel?: string | null;
  ready: boolean;
  progress: number;
  status: BootstrapAssetCardStatus;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

type InitializeCheckVisualStatus = "done" | "warning" | "blocked" | "pending";

type InitializeCheckItem = {
  key: string;
  title: string;
  summary: string;
  detail: string;
  status: InitializeCheckVisualStatus;
};

function getFlowSteps(view: BootstrapFlowView, t: Translate) {
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

function formatModelDisplayName(modelKey?: string | null) {
  if (!modelKey) return "VoxCPM2";

  const displayNameMap: Record<string, string> = {
    voxcpm2: "VoxCPM2",
    "voxcpm2-default": "VoxCPM2",
    voxcpm1_5: "VoxCPM1.5",
    "voxcpm1.5-default": "VoxCPM1.5",
    voxcpm_05b: "VoxCPM-0.5B",
    "voxcpm-0.5b-default": "VoxCPM-0.5B",
  };

  return displayNameMap[modelKey] ?? modelKey;
}

function clampProgress(progress?: number | null) {
  return Math.max(0, Math.min(Math.round(progress ?? 0), 100));
}

function getBundleProgress(bootstrapState: BootstrapState, downloadTask?: TaskRecord | null) {
  if (!downloadTask) {
    return bootstrapState.phase === "model_download" ? 0 : phaseProgress[bootstrapState.phase];
  }

  const progress = clampProgress(downloadTask.progress ?? 0);
  if (downloadTask.status === "failed") {
    return Math.min(progress, 99);
  }

  return progress;
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(value, 0);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatStorageBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(value, 0);
  let unitIndex = 0;
  while (size >= 1000 && unitIndex < units.length - 1) {
    size /= 1000;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDownloadSummary(downloadTask?: TaskRecord | null) {
  const structured = downloadTask?.downloadProgress;
  if (!structured) {
    return null;
  }

  if (structured.totalBytesComplete && structured.totalBytes && structured.totalBytes > 0) {
    const downloaded = formatBytes(structured.downloadedBytes);
    const total = formatBytes(structured.totalBytes);
    if (structured.totalFiles && structured.totalFiles > 0) {
      return `${downloaded} / ${total} (${structured.completedFiles}/${structured.totalFiles})`;
    }
    return `${downloaded} / ${total}`;
  }

  if (structured.totalFiles && structured.totalFiles > 0) {
    return `${structured.completedFiles} / ${structured.totalFiles} files`;
  }

  return null;
}

function formatSetupEnvironmentReason(reason: string | null | undefined, t: Translate) {
  switch (reason) {
    case "python_service_venv_missing":
      return t("bootstrap.init.environmentMissing");
    case "python_sidecar_not_ready":
      return t("bootstrap.init.environmentStarting");
    case "python_sidecar_boot_failed":
      return t("bootstrap.init.environmentFailed");
    case "tauri_not_available":
      return t("bootstrap.init.environmentUnavailable");
    default:
      return t("bootstrap.init.environmentUnknown");
  }
}

function getInitializeChecks(
  setupDiagnostics: SetupDiagnostics | null | undefined,
  t: Translate,
): InitializeCheckItem[] {
  const recommendedMemoryBytes = setupDiagnostics?.recommendedMemoryBytes ?? 12 * 1024 * 1024 * 1024;
  const minimumFreeStorageBytes = setupDiagnostics?.minimumFreeStorageBytes ?? 5_000_000_000;
  const totalMemoryBytes = setupDiagnostics?.totalMemoryBytes ?? null;
  const availableStorageBytes = setupDiagnostics?.availableStorageBytes ?? null;
  const memoryLow = totalMemoryBytes !== null && totalMemoryBytes < recommendedMemoryBytes;
  const storageInsufficient =
    availableStorageBytes !== null && availableStorageBytes < minimumFreeStorageBytes;

  const cpuSummary = setupDiagnostics
    ? [setupDiagnostics.cpuName, totalMemoryBytes !== null ? formatBytes(totalMemoryBytes) : null]
        .filter(Boolean)
        .join(" · ")
    : t("bootstrap.init.detecting");
  const storageSummary = setupDiagnostics
    ? availableStorageBytes !== null
      ? formatStorageBytes(availableStorageBytes)
      : t("bootstrap.init.detecting")
    : t("bootstrap.init.detecting");

  let environmentStatus: InitializeCheckVisualStatus = "pending";
  if (setupDiagnostics?.environmentStatus === "ready") {
    environmentStatus = "done";
  } else if (setupDiagnostics?.environmentStatus === "missing" || setupDiagnostics?.environmentStatus === "error") {
    environmentStatus = "blocked";
  }

  return [
    {
      key: "device",
      title: t("bootstrap.init.deviceTitle"),
      summary: cpuSummary,
      detail: memoryLow
        ? t("bootstrap.init.memoryWarning", {
            memory: totalMemoryBytes !== null ? formatBytes(totalMemoryBytes) : t("bootstrap.init.detecting"),
            recommended: formatBytes(recommendedMemoryBytes),
          })
        : totalMemoryBytes !== null
          ? t("bootstrap.init.memoryHealthy", { memory: formatBytes(totalMemoryBytes) })
          : t("bootstrap.init.detecting"),
      status: setupDiagnostics ? (memoryLow ? "warning" : "done") : "pending",
    },
    {
      key: "storage",
      title: t("bootstrap.init.storageTitle"),
      summary: storageSummary,
      detail: storageInsufficient
        ? t("bootstrap.init.storageWarning", {
            available: availableStorageBytes !== null ? formatStorageBytes(availableStorageBytes) : t("bootstrap.init.detecting"),
            minimum: formatStorageBytes(minimumFreeStorageBytes),
          })
        : availableStorageBytes !== null
          ? t("bootstrap.init.storageHealthy", {
              available: formatStorageBytes(availableStorageBytes),
              minimum: formatStorageBytes(minimumFreeStorageBytes),
            })
          : t("bootstrap.init.detecting"),
      status: setupDiagnostics ? (storageInsufficient ? "blocked" : "done") : "pending",
    },
    {
      key: "environment",
      title: t("bootstrap.init.environmentTitle"),
      summary: setupDiagnostics
        ? setupDiagnostics.environmentStatus === "ready"
          ? t("bootstrap.init.environmentReady")
          : setupDiagnostics.environmentStatus === "starting"
            ? t("bootstrap.init.environmentChecking")
            : t("bootstrap.init.environmentNotReady")
        : t("bootstrap.init.detecting"),
      detail: setupDiagnostics
        ? formatSetupEnvironmentReason(setupDiagnostics.environmentReason, t)
        : t("bootstrap.init.detecting"),
      status: setupDiagnostics ? environmentStatus : "pending",
    },
  ];
}

function getBootstrapAssetCards(
  bootstrapAssets: BootstrapAssetStatus[],
  assetProgress: BootstrapAssetDownloadProgress[],
): BootstrapAssetCard[] {
  const progressByModelKey = new Map(assetProgress.map((item) => [item.modelKey, item]));

  if (bootstrapAssets.length > 0) {
    return bootstrapAssets.map((asset) => {
      const progress = progressByModelKey.get(asset.modelKey);
      const status: BootstrapAssetCardStatus = asset.ready ? "succeeded" : (progress?.status ?? "pending");
      return {
        modelKey: asset.modelKey,
        displayName: asset.displayName,
        localDir: asset.localDir,
        approxSizeLabel: asset.approxSizeLabel ?? null,
        ready: asset.ready || status === "succeeded",
        progress: asset.ready ? 100 : clampProgress(progress?.progress ?? 0),
        status,
      };
    });
  }

  return assetProgress.map((asset) => ({
    modelKey: asset.modelKey,
    displayName: asset.displayName,
    ready: asset.status === "succeeded",
    progress: clampProgress(asset.progress),
    status: asset.status,
  }));
}

function formatBootstrapAssetStatus(status: BootstrapAssetCardStatus, t: Translate) {
  if (status === "succeeded") return t("bootstrap.complete.assetReady");
  if (status === "running") return t("bootstrap.download.assetPreparing");
  if (status === "failed") return t("common.taskStatus.failed");
  return t("bootstrap.download.assetPending");
}

export function BootstrapFlowPage({
  view,
  bootstrapState,
  providerRecommendation: _providerRecommendation,
  preparedModel,
  sidecarStatus,
  serviceInfo,
  setupDiagnostics,
  downloadTask,
  bootstrapModel,
  onStartSetup,
  onProceedFromInitialize,
  canProceedFromInitialize,
  onEnterWorkspace,
  onRetryDownload,
}: BootstrapFlowPageProps) {
  const { t } = useTranslation();
  const bootstrapAssets = serviceInfo?.bootstrapAssets ?? [];
  const initializeChecks = getInitializeChecks(setupDiagnostics, t);
  const bootstrapAssetCards = getBootstrapAssetCards(bootstrapAssets, downloadTask?.bootstrapAssetProgress ?? []);
  const activeBootstrapAsset =
    bootstrapAssetCards.find((asset) => asset.status === "running") ??
    bootstrapAssetCards.find((asset) => !asset.ready) ??
    bootstrapAssetCards[0];
  const progress = getBundleProgress(bootstrapState, downloadTask);
  const downloadModelName =
    activeBootstrapAsset?.displayName ??
    downloadTask?.downloadProgress?.currentFile ??
    bootstrapModel?.displayName ??
    formatModelDisplayName(downloadTask?.result?.modelKey ?? preparedModel?.modelKey);
  const downloadBundleName = t("bootstrap.download.bundleName");
  const downloadSummary = formatDownloadSummary(downloadTask);
  const preferStructuredSummary = downloadTask?.downloadProgress?.phase === "downloading";
  const downloadStatusText =
    downloadTask?.status === "failed"
      ? downloadTask.error?.message || downloadTask.message || t("bootstrap.download.desc")
      : preferStructuredSummary
        ? downloadSummary || downloadTask?.message || t("bootstrap.download.desc")
        : downloadTask?.message || downloadSummary || t("bootstrap.download.desc");
  const canRetryDownload =
    downloadTask?.status === "failed" || downloadTask?.status === "cancelled";
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
              <div className="steps-card steps-card--checks">
                {initializeChecks.map((step) => (
                  <div key={step.title} className="steps-card__item">
                    <div className={`steps-card__icon steps-card__icon--${step.status}`}>
                      {step.status === "done" ? <IconCheck size={14} /> : step.status === "warning" || step.status === "blocked" ? <IconAlert size={14} /> : "…"}
                    </div>
                    <div className="steps-card__info">
                      <div className="steps-card__info-title">{step.title}</div>
                      <div className="steps-card__info-desc">{step.summary}</div>
                      <div className="steps-card__info-meta">{step.detail}</div>
                    </div>
                    <span className={`steps-card__status steps-card__status--${step.status}`}>
                      {step.status === "done"
                        ? t("bootstrap.init.statusDone")
                        : step.status === "warning"
                          ? t("bootstrap.init.statusWarning")
                          : step.status === "blocked"
                            ? t("bootstrap.init.statusBlocked")
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
            <p className="bootstrap-page__desc">{downloadStatusText}</p>
            <div className="bootstrap-page__content">
              <div className="progress-card">
                <div className="progress-card__top">
                  <div className="progress-card__title-group">
                    <span className="progress-card__model-name">{downloadBundleName}</span>
                    {activeBootstrapAsset ? (
                      <span className="progress-card__subtext">{downloadModelName}</span>
                    ) : null}
                  </div>
                  <span className="progress-card__percent">{progress}%</span>
                </div>
                <div className="progress-card__bar">
                  <div className="progress-card__fill" style={{ width: `${progress}%` }} />
                </div>
              </div>
              {bootstrapAssetCards.length > 0 ? (
                <div className="bootstrap-asset-cards">
                  {bootstrapAssetCards.map((asset) => (
                    <div key={asset.modelKey} className="bootstrap-asset-card">
                      <div className="bootstrap-asset-card__top">
                        <div className="bootstrap-asset-card__label">{asset.displayName}</div>
                        <div className={`bootstrap-asset-card__percent bootstrap-asset-card__percent--${asset.status}`}>
                          {asset.progress}%
                        </div>
                      </div>
                      <div className="bootstrap-asset-card__bar">
                        <div
                          className={`bootstrap-asset-card__fill bootstrap-asset-card__fill--${asset.status}`}
                          style={{ width: `${asset.progress}%` }}
                        />
                      </div>
                      <div className={`bootstrap-asset-card__status bootstrap-asset-card__status--${asset.status}`}>
                        {formatBootstrapAssetStatus(asset.status, t)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
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
                    {formatModelDisplayName(preparedModel?.modelKey)}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.deviceLabel")}</div>
                  <div className="summary-card__value">MPS (Apple Silicon)</div>
                </div>
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.asrLabel")}</div>
                  <div className="summary-card__value">
                    {serviceInfo?.asrModelReady ? t("bootstrap.complete.assetReady") : t("bootstrap.complete.assetWaiting")}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-card__label">{t("bootstrap.complete.enhancerLabel")}</div>
                  <div className="summary-card__value">
                    {serviceInfo?.zipEnhancerReady
                      ? t("bootstrap.complete.assetReady")
                      : t("bootstrap.complete.assetWaiting")}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {(view === "initialize" || view === "download") && (
        <div className="bootstrap-page__footer">
          <button
            className="btn btn--glass"
            disabled={
              view === "download"
                ? !canRetryDownload || !onRetryDownload
                : !canProceedFromInitialize || !onProceedFromInitialize
            }
            onClick={
              view === "download"
                ? (canRetryDownload ? onRetryDownload : undefined)
                : canProceedFromInitialize
                  ? onProceedFromInitialize
                  : undefined
            }
          >
            {view === "download" && canRetryDownload ? t("common.errorActions.retry") : t("bootstrap.flow.nextBtn")}
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
