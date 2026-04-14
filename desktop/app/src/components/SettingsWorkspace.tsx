import { useEffect, useState } from "react";
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
import { clearCache, exportLogs, openStorageDirectory } from "../lib/tauri";
import { IconCheck, IconDownload } from "./Icons";
import { CustomSelect } from "./CustomSelect";

function formatInferenceDevice(serviceInfo: ServiceInfo | null) {
  const deviceName = serviceInfo?.deviceName?.trim();
  const deviceType = serviceInfo?.deviceType?.trim();

  if (deviceName && deviceType) {
    return `${deviceName} [${deviceType}]`;
  }

  return deviceName || deviceType || "—";
}

function getModelStorageDir(modelPath?: string | null) {
  const fallback = "~/Library/Application Support/Voca/models";
  if (!modelPath) return fallback;

  const normalizedPath = modelPath.replace(/\\/g, "/");
  const marker = "/models/";
  const markerIndex = normalizedPath.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalizedPath.slice(0, markerIndex + marker.length - 1);
  }

  return normalizedPath;
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
  ) => void;
};

export function SettingsWorkspace({
  bootstrapState,
  sidecarStatus,
  providerRecommendation,
  preparedModel,
  modelCatalog,
  downloadedModelCatalog,
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
  const [clearingCache, setClearingCache] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [openingStorageDir, setOpeningStorageDir] = useState(false);
  const completedTasks = taskHistory.filter((t) => t.status === "succeeded").length;
  const modelStorageDir = serviceInfo?.modelDir ?? getModelStorageDir(preparedModel?.modelPath);

  useEffect(() => {
    setCacheBytes(serviceInfo?.cacheBytes ?? 0);
  }, [serviceInfo?.cacheBytes]);

  const handleClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    try {
      const result = await clearCache();
      if (result?.success) {
        const remainingBytes = result.serviceInfo?.cacheBytes ?? result.remainingBytes ?? 0;
        setCacheBytes(remainingBytes);
        onCacheCleared(result.serviceInfo ?? null, result.removedTaskIds ?? [], remainingBytes);
      }
    } finally {
      setClearingCache(false);
    }
  };

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
            {t("settings.modelManagement.count", { count: modelCatalog.length })}
          </span>
        </div>
        <div className="model-list">
          {modelCatalog.map((model) => {
            const isDownloaded = downloadedModelCatalog.some(
              (entry) => entry.modelKey === model.modelKey,
            );
            return (
              <div key={model.modelKey} className="model-item">
                <div className="model-item__info">
                  <div className="model-item__name">{model.displayName}</div>
                  <div className="model-item__desc">{model.localDir}</div>
                </div>
                {isDownloaded ? (
                  <div className="model-item__action model-item__action--downloaded"><IconCheck size={16} /></div>
                ) : (
                  <button
                    className="model-item__action model-item__action--download"
                    onClick={() => void onPrepareModel(model.modelKey, providerPreference, true)}
                    type="button"
                  >
                    <IconDownload size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
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

      {/* Logs & Maintenance + General Settings */}
      <div className="settings-bottom-grid">
        <div className="settings-section" style={{ marginTop: 0 }}>
          <div className="settings-section__title">{t("settings.logs.title")}</div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.logLevel")}</span>
            <span className="kv-row__value">{serviceInfo?.logLevel ?? "warning"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.managedStorage")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.managedStorageBytes)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.modelDir")}</span>
            <span className="kv-row__value">
              {modelStorageDir}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.modelSize")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.modelBytes)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.voiceLibrary")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.voiceLibraryBytes)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.downloadCache")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.downloadCacheBytes)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.logSize")}</span>
            <span className="kv-row__value">{formatBytes(serviceInfo?.logBytes)}</span>
          </div>
          <div className="cache-row">
            <span className="cache-row__left">{t("settings.logs.cache")}</span>
            <div className="cache-row__right">
              <span className="cache-row__size">{formatBytes(cacheBytes)}</span>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => void handleClearCache()}
                disabled={clearingCache}
              >
                {t("settings.logs.clearCache")}
              </button>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="settings-actions">
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
    </>
  );
}
