import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapState,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SidecarStatus,
  StorageInfo,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import i18n, { LANGUAGE_NATIVE_LABELS, resolveAppLanguage, setAppLanguage } from "../i18n";
import { useModalTransition } from "../lib/useModalTransition";
import {
  checkForUpdate,
  exportLogs,
  getTask,
  openExternalUrl,
  openStorageDirectory,
  pickDirectory,
  startModelDownload,
  type UpdateCheckResult,
} from "../lib/tauri";
import { IconCheck, IconChevronDown, IconDownload, IconHeart } from "./Icons";
import { UpdateAvailableModal } from "./UpdateAvailableModal";
import { CustomSelect } from "./CustomSelect";
import { StorageModal } from "./StorageModal";

const DEFAULT_AUDIO_DOWNLOAD_PATH = "~/Downloads/Voca";
const AUDIO_DOWNLOAD_PATH_KEY = "voca.audioDownloadPath";

export function getAudioDownloadPath(): string {
  return localStorage.getItem(AUDIO_DOWNLOAD_PATH_KEY) || DEFAULT_AUDIO_DOWNLOAD_PATH;
}

function abbreviateHomePath(fullPath: string): string {
  const home = "/Users/";
  if (fullPath.startsWith(home)) {
    const rest = fullPath.slice(home.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx !== -1) {
      return "~" + rest.slice(slashIdx);
    }
  }
  return fullPath;
}

const ASSET_ROLE_I18N_KEY: Record<string, string> = {
  asr: "settings.modelManagement.roleAsr",
  enhancer: "settings.modelManagement.roleEnhancer",
};

function getModelPageUrl(
  model: { providers: { huggingface?: { repoId: string }; modelscope?: { modelId: string } } },
  preference: "auto" | "huggingface" | "modelscope",
): string | null {
  if (preference === "modelscope" && model.providers.modelscope) {
    return `https://modelscope.cn/models/${model.providers.modelscope.modelId}`;
  }
  if (model.providers.huggingface) {
    return `https://huggingface.co/${model.providers.huggingface.repoId}`;
  }
  if (model.providers.modelscope) {
    return `https://modelscope.cn/models/${model.providers.modelscope.modelId}`;
  }
  return null;
}

function formatInferenceDevice(serviceInfo: ServiceInfo | null) {
  const deviceName = serviceInfo?.deviceName?.trim();
  const deviceType = serviceInfo?.deviceType?.trim();

  if (deviceName && deviceType) {
    return `${deviceName} [${deviceType}]`;
  }

  return deviceName || deviceType || "—";
}

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

const PROGRESS_RING_SIZE = 32;
const PROGRESS_RING_STROKE = 2.5;
const PROGRESS_RING_RADIUS = (PROGRESS_RING_SIZE - PROGRESS_RING_STROKE) / 2;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

function ProgressRing({ progress }: { progress: number }) {
  const clamped = Math.max(0, Math.min(progress, 100));
  const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - clamped / 100);
  return (
    <div className="model-item__action model-item__action--downloading">
      <svg className="model-item__ring" width={PROGRESS_RING_SIZE} height={PROGRESS_RING_SIZE}>
        <circle
          className="model-item__ring-track"
          cx={PROGRESS_RING_SIZE / 2}
          cy={PROGRESS_RING_SIZE / 2}
          r={PROGRESS_RING_RADIUS}
          fill="none"
          strokeWidth={PROGRESS_RING_STROKE}
        />
        <circle
          className="model-item__ring-fill"
          cx={PROGRESS_RING_SIZE / 2}
          cy={PROGRESS_RING_SIZE / 2}
          r={PROGRESS_RING_RADIUS}
          fill="none"
          strokeWidth={PROGRESS_RING_STROKE}
          strokeDasharray={PROGRESS_RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="model-item__ring-label">{clamped}%</span>
    </div>
  );
}

type SettingsWorkspaceProps = {
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
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onRefreshStorageInfo: () => Promise<void>;
  onCacheCleared: (
    storageInfo: StorageInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => void;
};

export function SettingsWorkspace({
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
  taskHistory,
  onPrepareModel,
  onRefreshStorageInfo,
  onCacheCleared,
}: SettingsWorkspaceProps) {
  const { t } = useTranslation();
  const currentLanguage = resolveAppLanguage(i18n.resolvedLanguage ?? i18n.language);
  const languageOptions = [
    { value: "zh-CN", label: LANGUAGE_NATIVE_LABELS["zh-CN"] },
    { value: "zh-TW", label: LANGUAGE_NATIVE_LABELS["zh-TW"] },
    { value: "en", label: LANGUAGE_NATIVE_LABELS.en },
  ];
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">(
    providerRecommendation?.preferred ?? "auto",
  );
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [openingStorageDir, setOpeningStorageDir] = useState(false);
  const [auxExpanded, setAuxExpanded] = useState(false);
  const [downloadingTasks, setDownloadingTasks] = useState<Record<string, TaskRecord>>({});
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateCheckPhase, setUpdateCheckPhase] = useState<"idle" | "checking" | "result" | "error">("idle");
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateToast, setUpdateToast] = useState<string | null>(null);
  const updateToastTimer = useRef<number | null>(null);
  const storageModal = useModalTransition(storageModalOpen);
  const updateModalOpen = updateCheckPhase === "result" && (updateCheckResult?.updateAvailable ?? false);
  const updateModal = useModalTransition(updateModalOpen);
  const [downloadSpeeds, setDownloadSpeeds] = useState<Record<string, number | null>>({});
  const speedSamplesRef = useRef<Record<string, { bytes: number; atMs: number }>>({});
  const [audioDownloadPath, setAudioDownloadPath] = useState(() => getAudioDownloadPath());
  const completedTasks = taskHistory.filter((t) => t.status === "succeeded").length;
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Pre-warm the storage snapshot once the sidecar is healthy and we
  // don't already have data. On Windows the recursive directory walk can
  // take 1~3 seconds; firing it while the user is still reading the
  // settings page means the storage modal almost always opens instantly
  // instead of showing a "calculating" state on first click.
  useEffect(() => {
    if (!sidecarStatus.healthy) return;
    if (storageInfo !== null) return;
    void onRefreshStorageInfo().catch(() => {
      // Swallow here — the modal owns the user-facing retry UI when the
      // user actually opens it.
    });
  }, [sidecarStatus.healthy, storageInfo, onRefreshStorageInfo]);

  const showUpdateToast = useCallback((message: string) => {
    setUpdateToast(message);
    if (updateToastTimer.current) window.clearTimeout(updateToastTimer.current);
    updateToastTimer.current = window.setTimeout(() => setUpdateToast(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (updateToastTimer.current) window.clearTimeout(updateToastTimer.current);
    };
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateCheckPhase("checking");
    setUpdateToast(null);
    try {
      const data = await checkForUpdate();
      setUpdateCheckResult(data);
      if (data.updateAvailable) {
        setUpdateCheckPhase("result");
      } else {
        setUpdateCheckPhase("idle");
        showUpdateToast(t("settings.general.updateUpToDate"));
      }
    } catch {
      setUpdateCheckResult(null);
      setUpdateCheckPhase("idle");
      showUpdateToast(t("settings.general.updateCheckFailedNetwork"));
    }
  }, [t, showUpdateToast]);

  const handleModelDownload = useCallback(async (modelKey: string) => {
    const task = await startModelDownload(modelKey, providerPreference);
    if (task) {
      setDownloadingTasks((prev) => ({ ...prev, [modelKey]: task }));
    }
  }, [providerPreference]);

  useEffect(() => {
    const activeEntries = Object.entries(downloadingTasks).filter(
      ([, task]) => !["succeeded", "failed", "cancelled"].includes(task.status),
    );

    if (activeEntries.length === 0) {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    if (pollTimerRef.current) return;

    pollTimerRef.current = window.setInterval(() => {
      for (const [modelKey, task] of Object.entries(downloadingTasks)) {
        if (["succeeded", "failed", "cancelled"].includes(task.status)) continue;
        void getTask(task.id).then((updated) => {
          if (!updated) return;
          setDownloadingTasks((prev) => ({ ...prev, [modelKey]: updated }));

          const currentBytes = updated.downloadProgress?.downloadedBytes ?? 0;
          const nowMs = Date.now();
          const prev = speedSamplesRef.current[modelKey];
          if (prev && currentBytes > prev.bytes) {
            const deltaMs = nowMs - prev.atMs;
            if (deltaMs > 0) {
              const bps = ((currentBytes - prev.bytes) / deltaMs) * 1000;
              setDownloadSpeeds((s) => ({
                ...s,
                [modelKey]: s[modelKey] ? s[modelKey]! * 0.6 + bps * 0.4 : bps,
              }));
            }
          }
          speedSamplesRef.current[modelKey] = { bytes: currentBytes, atMs: nowMs };

          if (updated.status === "succeeded") {
            setDownloadSpeeds((s) => ({ ...s, [modelKey]: null }));
            delete speedSamplesRef.current[modelKey];
            void onPrepareModel(modelKey, providerPreference, false);
          }
        });
      }
    }, 800);

    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [downloadingTasks, onPrepareModel, providerPreference]);

  const handleExportLogs = async () => {
    if (!serviceInfo?.logDir || exportingLogs) return;
    setExportingLogs(true);
    try {
      await exportLogs(serviceInfo.logDir);
    } finally {
      setExportingLogs(false);
    }
  };

  const handleOpenStorageDir = async () => {
    if (!serviceInfo?.storageDir || openingStorageDir) return;
    setOpeningStorageDir(true);
    try {
      await openStorageDirectory(serviceInfo.storageDir);
    } finally {
      setOpeningStorageDir(false);
    }
  };

  const handlePickAudioDownloadPath = useCallback(async () => {
    const selected = await pickDirectory(audioDownloadPath);
    if (selected) {
      localStorage.setItem(AUDIO_DOWNLOAD_PATH_KEY, selected);
      setAudioDownloadPath(selected);
    }
  }, [audioDownloadPath]);

  const handleStorageCacheCleared = (
    updatedStorageInfo: StorageInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => {
    onCacheCleared(updatedStorageInfo, removedTaskIds, remainingBytes, clearedAudioDirs);
  };

  return (
    <>
      <h1 className="settings-title">{t("settings.title")}</h1>

      {/* Service Status & Diagnostics */}
      <div className="settings-section">
        <div className="settings-section__title">{t("settings.serviceStatus.title")}</div>
        <div className="kv-grid">
          <div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.status")}</span>
              <span className="kv-row__value kv-row__value--green">
                {sidecarStatus.healthy ? (
                  <><IconCheck size={14} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />{t("settings.serviceStatus.running")}</>
                ) : t("settings.serviceStatus.stopped")}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.address")}</span>
              <span className="kv-row__value">127.0.0.1:8765</span>
            </div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.device")}</span>
              <span className="kv-row__value">{formatInferenceDevice(serviceInfo)}</span>
            </div>
          </div>
          <div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.completedTasks")}</span>
              <span className="kv-row__value">{completedTasks}</span>
            </div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.modelLoaded")}</span>
              <span className="kv-row__value">
                {preparedModel?.configExists ? t("settings.serviceStatus.yes") : t("settings.serviceStatus.no")}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.recentError")}</span>
              <span className="kv-row__value">
                {bootstrapState.lastError?.message ?? t("settings.serviceStatus.none")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Model Management */}
      <div className="settings-section">
        <div className="settings-section__header">
          <div className="settings-section__title" style={{ marginBottom: 0 }}>
            {t("settings.modelManagement.title")}
          </div>
          <span className="settings-section__count">
            {t("settings.modelManagement.count", { count: modelCatalog.length + auxiliaryModelCatalog.length })}
          </span>
        </div>
        <div className="model-list">
          {modelCatalog.map((model) => {
            const isDownloaded = downloadedModelCatalog.some(
              (entry) => entry.modelKey === model.modelKey,
            );
            const dlTask = downloadingTasks[model.modelKey];
            const isDownloading = dlTask && !["succeeded", "failed", "cancelled"].includes(dlTask.status);
            return (
              <div key={model.modelKey} className="model-item">
                <div className="model-item__info">
                  <div className="model-item__name">
                    {model.displayName}
                    {getModelPageUrl(model, providerPreference) && (
                      <button
                        className="model-item__heart"
                        type="button"
                        onClick={() => void openExternalUrl(getModelPageUrl(model, providerPreference)!)}
                      >
                        <IconHeart size={13} />
                      </button>
                    )}
                  </div>
                  <div className="model-item__desc">
                    {isDownloading && downloadSpeeds[model.modelKey] ? (
                      <span className="model-item__speed">{formatSpeed(downloadSpeeds[model.modelKey]!)}</span>
                    ) : model.tags && model.tags.length > 0 ? (
                      <div className="model-item__tags">
                        {model.tags.map((tag) => (
                          <span key={tag} className="model-item__tag-pill">{tag.startsWith("settings.") ? t(tag) : tag}</span>
                        ))}
                        {model.approxSizeLabel && <span className="model-item__tag-pill">{model.approxSizeLabel}</span>}
                      </div>
                    ) : (
                      <>
                        {model.descriptionKey ? t(model.descriptionKey) : model.description ?? model.localDir}
                        {model.approxSizeLabel && <span className="model-item__size">{model.approxSizeLabel}</span>}
                      </>
                    )}
                  </div>
                </div>
                {isDownloaded ? (
                  <div className="model-item__action model-item__action--downloaded"><IconCheck size={16} /></div>
                ) : isDownloading ? (
                  <ProgressRing progress={dlTask.progress ?? 0} />
                ) : (
                  <button
                    className="model-item__action model-item__action--download"
                    onClick={() => void handleModelDownload(model.modelKey)}
                    type="button"
                  >
                    <IconDownload size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {auxiliaryModelCatalog.length > 0 && (
          <>
            <button
              className="model-group-toggle"
              type="button"
              onClick={() => setAuxExpanded((v) => !v)}
            >
              <IconChevronDown
                size={14}
                className={`model-group-toggle__icon${auxExpanded ? " model-group-toggle__icon--open" : ""}`}
              />
              <span className="model-group-toggle__label">
                {t("settings.modelManagement.auxiliaryModels")}
                <span className="model-group-toggle__count">({auxiliaryModelCatalog.length})</span>
              </span>
            </button>
            <div className={`model-group-collapsible${auxExpanded ? " model-group-collapsible--open" : ""}`}>
              <div className="model-list">
                {auxiliaryModelCatalog.map((model) => {
                  const isDownloaded = downloadedAuxiliaryModelCatalog.some(
                    (entry) => entry.modelKey === model.modelKey,
                  );
                  const roleKey = ASSET_ROLE_I18N_KEY[model.assetRole];
                  const dlTask = downloadingTasks[model.modelKey];
                  const isDownloading = dlTask && !["succeeded", "failed", "cancelled"].includes(dlTask.status);
                  return (
                    <div key={model.modelKey} className="model-item">
                      <div className="model-item__info">
                        <div className="model-item__name">
                          {model.displayName}
                          {roleKey && <span className="model-item__tag">{t(roleKey)}</span>}
                          {getModelPageUrl(model, providerPreference) && (
                            <button
                              className="model-item__heart"
                              type="button"
                              onClick={() => void openExternalUrl(getModelPageUrl(model, providerPreference)!)}
                            >
                              <IconHeart size={13} />
                            </button>
                          )}
                        </div>
                        <div className="model-item__desc">
                          {isDownloading && downloadSpeeds[model.modelKey] ? (
                            <span className="model-item__speed">{formatSpeed(downloadSpeeds[model.modelKey]!)}</span>
                          ) : model.tags && model.tags.length > 0 ? (
                            <div className="model-item__tags">
                              {model.tags.map((tag) => (
                                <span key={tag} className="model-item__tag-pill">{tag.startsWith("settings.") ? t(tag) : tag}</span>
                              ))}
                              {model.approxSizeLabel && <span className="model-item__tag-pill">{model.approxSizeLabel}</span>}
                            </div>
                          ) : (
                            <>
                              {model.descriptionKey ? t(model.descriptionKey) : model.description ?? model.localDir}
                              {model.approxSizeLabel && <span className="model-item__size">{model.approxSizeLabel}</span>}
                            </>
                          )}
                        </div>
                      </div>
                      {isDownloaded ? (
                        <div className="model-item__action model-item__action--downloaded"><IconCheck size={16} /></div>
                      ) : isDownloading ? (
                        <ProgressRing progress={dlTask.progress ?? 0} />
                      ) : (
                        <button
                          className="model-item__action model-item__action--download"
                          onClick={() => void handleModelDownload(model.modelKey)}
                          type="button"
                        >
                          <IconDownload size={16} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <div className="settings-divider" />
        <div className="download-source-row">
          <span className="download-source-row__label">{t("settings.modelManagement.source")}</span>
          <CustomSelect
            value={providerPreference}
            onChange={(v) => setProviderPreference(v as "auto" | "huggingface" | "modelscope")}
            options={[
              { value: "auto", label: t("common.auto") },
              { value: "huggingface", label: "HuggingFace" },
              { value: "modelscope", label: "ModelScope" },
            ]}
          />
        </div>
      </div>

      {/* Storage & Maintenance + General Settings */}
      <div className="settings-bottom-grid">
        <div className="settings-section" style={{ marginTop: 0 }}>
          <div className="settings-section__title">{t("settings.logs.title")}</div>
          <div className="kv-row audio-path-row">
            <span className="kv-row__key">{t("settings.general.audioPath")}</span>
            <div className="audio-path-row__control">
              <span className="audio-path-row__path">{abbreviateHomePath(audioDownloadPath)}</span>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => void handlePickAudioDownloadPath()}
              >
                {t("settings.general.changePath")}
              </button>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.managedStorage")}</span>
            <span className="kv-row__value">
              {storageInfo ? formatBytes(storageInfo.managedStorageBytes) : "—"}
            </span>
          </div>
          <div className="settings-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn--small btn--secondary"
              type="button"
              onClick={() => {
                // The modal owns the refresh lifecycle now — it triggers
                // ``onRefreshStorageInfo`` on every mount and renders an
                // explicit loading / retry state while the walk is in
                // flight. We just need to open it here.
                setStorageModalOpen(true);
              }}
            >
              {t("settings.logs.manageStorage")}
            </button>
            <button
              className="btn btn--small btn--secondary"
              disabled={!serviceInfo?.logDir || exportingLogs}
              onClick={() => void handleExportLogs()}
              type="button"
            >
              {t("settings.logs.exportLogs")}
            </button>
            <button
              className="btn btn--small btn--secondary"
              disabled={!serviceInfo?.storageDir || openingStorageDir}
              onClick={() => void handleOpenStorageDir()}
              type="button"
            >
              {t("settings.logs.openDir")}
            </button>
          </div>
        </div>

        <div className="settings-section" style={{ marginTop: 0 }}>
          <div className="settings-section__title">{t("settings.general.title")}</div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.general.language")}</span>
            <CustomSelect
              value={currentLanguage}
              onChange={(lang) => {
                void setAppLanguage(resolveAppLanguage(lang));
              }}
              options={languageOptions}
            />
          </div>
          <div className="settings-divider" />
          <div className="version-row">
            <span className="version-row__left">{t("settings.general.version")}</span>
            <div className="version-row__right">
              <span className="version-row__value">Voca {appVersion ?? serviceInfo?.version}</span>
              <button
                className="btn btn--small btn--ghost"
                disabled={updateCheckPhase === "checking"}
                type="button"
                onClick={() => void handleCheckUpdate()}
              >
                {updateCheckPhase === "checking"
                  ? t("settings.general.updateChecking")
                  : t("settings.general.checkUpdate")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {storageModal.mounted && (
        <StorageModal
          storageInfo={storageInfo}
          closing={storageModal.closing}
          onRefresh={onRefreshStorageInfo}
          onCacheCleared={handleStorageCacheCleared}
          onClose={() => storageModal.requestClose(() => setStorageModalOpen(false))}
        />
      )}

      {updateModal.mounted && updateCheckResult?.updateAvailable && (
        <UpdateAvailableModal
          result={updateCheckResult}
          closing={updateModal.closing}
          onClose={() => updateModal.requestClose(() => setUpdateCheckPhase("idle"))}
        />
      )}

      {updateToast && (
        <div className="download-toast" onClick={() => setUpdateToast(null)}>
          {updateToast}
        </div>
      )}
    </>
  );
}
