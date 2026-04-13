import { useState } from "react";
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
import { clearCache } from "../lib/tauri";
import { IconCheck, IconDownload } from "./Icons";
import { CustomSelect } from "./CustomSelect";

type SettingsWorkspaceProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  modelCatalog: ModelCatalogEntry[];
  serviceInfo: ServiceInfo | null;
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
};

export function SettingsWorkspace({
  bootstrapState,
  sidecarStatus,
  providerRecommendation,
  preparedModel,
  modelCatalog,
  serviceInfo,
  taskHistory,
  onPrepareModel,
}: SettingsWorkspaceProps) {
  const { t } = useTranslation();
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">(
    providerRecommendation?.preferred ?? "auto",
  );
  const completedTasks = taskHistory.filter((t) => t.status === "succeeded").length;

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
              <span className="kv-row__value">{serviceInfo?.deviceType ?? "—"}</span>
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
            const isActive = preparedModel?.modelKey === model.modelKey;
            const isDownloaded = isActive && preparedModel?.existsLocally;
            return (
              <div key={model.modelKey} className={`model-item${isActive ? " model-item--active" : ""}`}>
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
            <span className="kv-row__value">warning</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.logs.modelDir")}</span>
            <span className="kv-row__value">
              {preparedModel?.modelPath ?? "~/Library/.../Voca/models"}
            </span>
          </div>
          <div className="cache-row">
            <span className="cache-row__left">{t("settings.logs.cache")}</span>
            <div className="cache-row__right">
              <span className="cache-row__size">128.5 MB</span>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => void clearCache()}
              >
                {t("settings.logs.clearCache")}
              </button>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="settings-actions">
            <button className="btn btn--small btn--secondary" disabled type="button">
              {t("settings.logs.exportLogs")}
            </button>
            <button className="btn btn--small btn--secondary" disabled type="button">
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
