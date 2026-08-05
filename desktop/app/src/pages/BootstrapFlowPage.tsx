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
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { StepIndicator } from "../components/StepIndicator";
import { useDownloadSpeed } from "../lib/useDownloadSpeed";

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

function formatDeviceTypeLabel(deviceType?: string | null) {
  if (!deviceType) return null;
  const normalised = deviceType.trim().toLowerCase();
  if (normalised === "mps") return "MPS";
  if (normalised === "cuda") return "CUDA";
  if (normalised === "cpu") return "CPU";
  return deviceType;
}

function cleanDeviceName(raw?: string | null): string | null {
  if (!raw) return null;
  let value = raw.replace(/\s+/g, " ").trim();
  if (!value) return null;
  // Strip marketing noise that bloats the card without adding information.
  value = value.replace(/\((?:R|TM|C)\)/gi, "");
  value = value.replace(/\b(?:Intel|NVIDIA|AMD|Advanced Micro Devices|Apple)\s+Corporation\b/gi, "");
  // ``Intel(R) Core(TM) i9-14900HX`` → ``Intel Core i9-14900HX``
  value = value.replace(/\bCore\s+(?:CPU|Processor)\b/gi, "Core");
  // ``NVIDIA GeForce RTX 4090 Laptop GPU`` → ``GeForce RTX 4090 Laptop``
  value = value.replace(/\s+(?:Graphics|GPU)$/i, "");
  // Apple silicon labels stay as-is once trimmed.
  value = value.replace(/\s+/g, " ").trim();
  return value || null;
}

type DeviceSummary = {
  primary: string;
  secondary: string | null;
};

function formatDeviceSummary(
  serviceInfo: ServiceInfo | null | undefined,
  setupDiagnostics: SetupDiagnostics | null | undefined,
  t: Translate,
): DeviceSummary {
  const deviceLabel = formatDeviceTypeLabel(serviceInfo?.deviceType);
  const deviceName = cleanDeviceName(serviceInfo?.deviceName);
  if (deviceName) {
    return { primary: deviceName, secondary: deviceLabel };
  }
  if (deviceLabel) {
    return { primary: deviceLabel, secondary: null };
  }
  const gpuName = cleanDeviceName(setupDiagnostics?.gpuName);
  const gpuMemoryBytes = setupDiagnostics?.gpuMemoryBytes ?? null;
  if (gpuName) {
    const memory = gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : null;
    return {
      primary: gpuName,
      secondary: memory ? `CUDA · ${memory}` : "CUDA",
    };
  }
  return { primary: t("bootstrap.init.detecting"), secondary: null };
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

function formatTransferRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return null;
  }
  if (bytesPerSecond === 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatDownloadSummary(downloadTask: TaskRecord | null | undefined, t: Translate) {
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
    return t("bootstrap.download.filesCount", {
      completed: structured.completedFiles,
      total: structured.totalFiles,
    });
  }

  return null;
}

function isWindowsPlatform(setupDiagnostics: SetupDiagnostics | null | undefined): boolean {
  // Treat the platform check as Windows-only when the backend explicitly
  // reports it. Older builds (pre-Windows-integration) don't emit `platform`
  // and ran on macOS, so an absent value falls back to the non-Windows path.
  return setupDiagnostics?.platform === "windows";
}

function buildWindowsDeviceCheck(
  setupDiagnostics: SetupDiagnostics,
  t: Translate,
): InitializeCheckItem {
  // The Windows inference backend is llama.cpp + Vulkan: any GPU with a
  // Vulkan-capable driver qualifies. Only an explicit `false` blocks — a
  // missing field (older Rust shell) reads as "unknown", not "unsupported".
  const vulkanMissing = setupDiagnostics.hasVulkanSupport === false;
  const minimumGpuMemoryBytes =
    setupDiagnostics.minimumGpuMemoryBytes ?? 6 * 1024 * 1024 * 1024;
  const gpuMemoryBytes = setupDiagnostics.gpuMemoryBytes ?? null;
  // Only warn about low VRAM when the reading is trustworthy, i.e. it came
  // from nvidia-smi (dedicated VRAM). WMI's AdapterRAM is a 32-bit field
  // capped at 4 GB, and integrated GPUs (Intel/AMD iGPU) share system RAM —
  // Windows only carves out a tiny "dedicated" block for them while Vulkan
  // can address up to ~half of system memory. Warning off those numbers
  // would false-alarm on every iGPU and most AMD cards; low system RAM is
  // already covered by the separate memory check.
  const hasReliableVramReading = setupDiagnostics.hasNvidiaGpu === true;
  const lowVram =
    hasReliableVramReading && gpuMemoryBytes !== null && gpuMemoryBytes < minimumGpuMemoryBytes;

  const summary = vulkanMissing
    ? t("bootstrap.init.vulkanMissing")
    : [
        setupDiagnostics.gpuName,
        // The VRAM number is only shown when it's dedicated VRAM from
        // nvidia-smi; iGPU/WMI readings understate usable memory.
        hasReliableVramReading && gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : null,
        lowVram ? t("bootstrap.init.lowVramHint") : null,
      ]
        .filter(Boolean)
        .join(" · ") || t("bootstrap.init.detecting");

  return {
    key: "device",
    title: t("bootstrap.init.deviceTitleGpu"),
    summary,
    // Low VRAM is advisory (slower, not unsupported) — warning, never block.
    status: vulkanMissing ? "blocked" : lowVram ? "warning" : "done",
  };
}

function buildHostDeviceCheck(
  setupDiagnostics: SetupDiagnostics,
  t: Translate,
): InitializeCheckItem {
  const recommendedMemoryBytes = setupDiagnostics.recommendedMemoryBytes ?? 12 * 1024 * 1024 * 1024;
  const totalMemoryBytes = setupDiagnostics.totalMemoryBytes ?? null;
  const memoryLow = totalMemoryBytes !== null && totalMemoryBytes < recommendedMemoryBytes;

  const summary = [
    setupDiagnostics.cpuName,
    totalMemoryBytes !== null ? formatBytes(totalMemoryBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ") || t("bootstrap.init.detecting");

  return {
    key: "device",
    title: t("bootstrap.init.deviceTitleCpu"),
    summary,
    // Memory shortfall is informational on macOS/Linux — we surface it as a
    // warning instead of blocking the bootstrap entirely (matching main).
    status: memoryLow ? "warning" : "done",
  };
}

function getInitializeChecks(
  setupDiagnostics: SetupDiagnostics | null | undefined,
  t: Translate,
): InitializeCheckItem[] {
  const minimumFreeStorageBytes = setupDiagnostics?.minimumFreeStorageBytes ?? 6_000_000_000;
  const availableStorageBytes = setupDiagnostics?.availableStorageBytes ?? null;
  const storageInsufficient =
    availableStorageBytes !== null && availableStorageBytes < minimumFreeStorageBytes;

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

  const deviceCheck: InitializeCheckItem = setupDiagnostics
    ? isWindowsPlatform(setupDiagnostics)
      ? buildWindowsDeviceCheck(setupDiagnostics, t)
      : buildHostDeviceCheck(setupDiagnostics, t)
    : {
        key: "device",
        title: t("bootstrap.init.deviceTitle"),
        summary: t("bootstrap.init.detecting"),
        status: "pending",
      };

  return [
    deviceCheck,
    {
      key: "storage",
      title: t("bootstrap.init.storageTitle"),
      summary: storageSummary,
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
      status: setupDiagnostics ? environmentStatus : "pending",
    },
  ];
}

function getBootstrapAssetCards(
  bootstrapAssets: BootstrapAssetStatus[],
  assetProgress: BootstrapAssetDownloadProgress[],
  taskStatus?: TaskRecord["status"] | null,
): BootstrapAssetCard[] {
  const progressByModelKey = new Map(assetProgress.map((item) => [item.modelKey, item]));
  const shouldPreferTaskProgress = assetProgress.length > 0 && taskStatus !== null && taskStatus !== undefined;

  if (bootstrapAssets.length > 0) {
    const knownAssetKeys = new Set(bootstrapAssets.map((asset) => asset.modelKey));
    const extraTaskCards = assetProgress
      .filter((asset) => !knownAssetKeys.has(asset.modelKey))
      .map((asset) => ({
        modelKey: asset.modelKey,
        displayName: asset.displayName,
        ready: asset.status === "succeeded",
        progress: clampProgress(asset.progress),
        status: asset.status,
      }));

    const bootstrapCards = bootstrapAssets.map((asset) => {
      const progress = progressByModelKey.get(asset.modelKey);
      if (shouldPreferTaskProgress) {
        const status: BootstrapAssetCardStatus =
          progress?.status ?? (taskStatus === "succeeded" ? "succeeded" : "pending");
        return {
          modelKey: asset.modelKey,
          displayName: asset.displayName,
          localDir: asset.localDir,
          approxSizeLabel: asset.approxSizeLabel ?? null,
          ready: status === "succeeded",
          progress: status === "succeeded" ? 100 : clampProgress(progress?.progress ?? 0),
          status,
        };
      }

      const status: BootstrapAssetCardStatus = asset.ready ? "succeeded" : "pending";
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

    return [...bootstrapCards, ...extraTaskCards];
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
  const bootstrapAssetCards = getBootstrapAssetCards(
    bootstrapAssets,
    downloadTask?.bootstrapAssetProgress ?? [],
    downloadTask?.status,
  );
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
  const downloadSummary = formatDownloadSummary(downloadTask, t);
  const preferStructuredSummary = downloadTask?.downloadProgress?.phase === "downloading";
  const downloadStatusText =
    downloadTask?.status === "failed"
      ? downloadTask.error?.message || downloadTask.message || t("bootstrap.download.desc")
      : preferStructuredSummary
        ? downloadSummary || downloadTask?.message || t("bootstrap.download.desc")
        : downloadTask?.message || downloadSummary || t("bootstrap.download.desc");
  const isDownloadErrorState =
    downloadTask?.status === "failed" || downloadTask?.status === "cancelled";
  const downloadMetaText =
    !isDownloadErrorState && downloadStatusText
      ? t("bootstrap.download.status", { status: downloadStatusText })
      : null;
  const progressInfo = downloadTask?.downloadProgress;
  const isSpeedTrackingActive =
    view === "download" &&
    downloadTask?.status === "running" &&
    progressInfo?.phase === "downloading";
  const downloadSpeedBps = useDownloadSpeed({
    active: isSpeedTrackingActive,
    downloadedBytes: progressInfo?.downloadedBytes,
    serverBytesPerSecond: progressInfo?.bytesPerSecond,
    currentFile: progressInfo?.currentFile ?? null,
  });
  const speedLabel = downloadSpeedBps !== null ? formatTransferRate(downloadSpeedBps) : null;
  const downloadSpeedText =
    downloadTask?.status === "running" && downloadTask.downloadProgress?.phase === "downloading"
      ? t("bootstrap.download.speed", { speed: speedLabel ?? t("bootstrap.download.speedPending") })
      : null;
  const canRetryDownload =
    downloadTask?.status === "failed" || downloadTask?.status === "cancelled";

  if (view === "welcome") {
    return (
      <main className="welcome-page">
        <div className="welcome-page__language">
          <LanguageSwitcher />
        </div>
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
        <div className="bootstrap-page__language">
          <LanguageSwitcher />
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
            <p className="bootstrap-page__desc">
              {isDownloadErrorState ? downloadStatusText : t("bootstrap.download.desc")}
            </p>
            {downloadMetaText ? <p className="bootstrap-page__meta">{downloadMetaText}</p> : null}
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
                {downloadSpeedText ? (
                  <div className="progress-card__footer">
                    <span className="progress-card__speed">{downloadSpeedText}</span>
                  </div>
                ) : null}
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
                {(() => {
                  const device = formatDeviceSummary(serviceInfo, setupDiagnostics, t);
                  return (
                    <div className="summary-card summary-card--device">
                      <div className="summary-card__label">{t("bootstrap.complete.deviceLabel")}</div>
                      <div className="summary-card__value">{device.primary}</div>
                      {device.secondary ? (
                        <div className="summary-card__caption">{device.secondary}</div>
                      ) : null}
                    </div>
                  );
                })()}
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
