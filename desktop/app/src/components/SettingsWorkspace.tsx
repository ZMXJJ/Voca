import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapState,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  ServiceInfo,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { exportLogs, getTask, openStorageDirectory, startModelDownload } from "../lib/tauri";
import { IconCheck, IconChevronDown, IconDownload } from "./Icons";
import { CustomSelect } from "./CustomSelect";
import { StorageModal } from "./StorageModal";

const ASSET_ROLE_I18N_KEY: Record<string, string> = {
  asr: "settings.modelManagement.roleAsr",
  enhancer: "settings.modelManagement.roleEnhancer",
};

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
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onCacheCleared: (
    serviceInfo: ServiceInfo | null,
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
  taskHistory,
  onPrepareModel,
  onCacheCleared,
}: SettingsWorkspaceProps) {
  const { t } = useTranslation();
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">(
    providerRecommendation?.preferred ?? "auto",
  );
  const [cacheBytes, setCacheBytes] = useState(serviceInfo?.cacheBytes ?? 0);
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [openingStorageDir, setOpeningStorageDir] = useState(false);
  const [auxExpanded, setAuxExpanded] = useState(false);
  const [downloadingTasks, setDownloadingTasks] = useState<Record<string, TaskRecord>>({});
  const completedTasks = taskHistory.filter((t) => t.status === "succeeded").length;
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCacheBytes(serviceInfo?.cacheBytes ?? 0);
  }, [serviceInfo?.cacheBytes]);

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
          if (updated.status === "succeeded") {
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

  const handleStorageCacheCleared = (
    updatedServiceInfo: ServiceInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => {
    setCacheBytes(remainingBytes);
    onCacheCleared(updatedServiceInfo, removedTaskIds, remainingBytes, clearedAudioDirs);
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
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.serviceStatus.phase")}</span>
              <span className="kv-row__value kv-row__value--accent">
                {bootstrapState.phase}
              </span>
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
                  <div className="model-item__name">{model.displayName}</div>
                  <div className="model-item__desc">{model.description ?? model.localDir}</div>
                </div>
                {isDownloaded ? (
                  <div className="model-item__action model-item__action--downloaded"><IconCheck size={16} /></div>
                ) : isDownloading ? (
                  <div className="model-item__action model-item__action--downloading">
                    {dlTask.progress ?? 0}%
                  </div>
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
                        </div>
                        <div className="model-item__desc">
                          {model.description ?? model.localDir}
                          {model.approxSizeLabel && <span className="model-item__size">{model.approxSizeLabel}</span>}
                        </div>
                      </div>
                      {isDownloaded ? (
                        <div className="model-item__action model-item__action--downloaded"><IconCheck size={16} /></div>
                      ) : isDownloading ? (
                        <div className="model-item__action model-item__action--downloading">
                          {dlTask.progress ?? 0}%
                        </div>
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
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.managedStorage")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.managedStorageBytes)}</span>
          </div>
          <div className="settings-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn--small btn--secondary"
              type="button"
              onClick={() => setStorageModalOpen(true)}
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
              value={i18n.language}
              onChange={(lang) => {
                void i18n.changeLanguage(lang);
                localStorage.setItem("voca.locale", lang);
              }}
              options={[
                { value: "zh-CN", label: "中文" },
                { value: "en", label: "English" },
              ]}
            />
          </div>
          <div className="audio-path-row">
            <div className="audio-path-row__label">{t("settings.general.audioPath")}</div>
            <div className="audio-path-row__control">
              <span className="audio-path-row__path">~/Downloads/Voca</span>
              <button className="btn btn--small btn--ghost" disabled type="button">
                {t("settings.general.changePath")}
              </button>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="version-row">
            <span className="version-row__left">{t("settings.general.version")}</span>
            <div className="version-row__right">
              <span className="version-row__value">Voca {serviceInfo?.version ?? "0.1.0"}</span>
              <button className="btn btn--small btn--ghost" disabled type="button">
                {t("settings.general.checkUpdate")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {storageModalOpen && (
        <StorageModal
          serviceInfo={serviceInfo}
          cacheBytes={cacheBytes}
          onCacheCleared={handleStorageCacheCleared}
          onClose={() => setStorageModalOpen(false)}
        />
      )}
    </>
  );
}
