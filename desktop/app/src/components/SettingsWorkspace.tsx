import { useMemo, useState } from "react";
import type {
  BootstrapState,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "./StatusBadge";

type SettingsWorkspaceProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
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
  taskHistory,
  onPrepareModel,
}: SettingsWorkspaceProps) {
  const { t } = useTranslation();
  const [modelKey, setModelKey] = useState(preparedModel?.modelKey ?? "voxcpm2-default");
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">(
    providerRecommendation?.preferred ?? "auto",
  );

  const latestFailedTask = useMemo(
    () => taskHistory.find((task) => task.status === "failed") ?? null,
    [taskHistory],
  );

  return (
    <section className="workspace-stack">
      <div className="page-grid page-grid--settings">
        <article className="panel summary-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("settings.overview.kicker")}</p>
              <h2 className="section-title">{t("settings.overview.title")}</h2>
            </div>
            <StatusBadge tone={sidecarStatus.healthy ? "success" : "warning"}>
              {sidecarStatus.healthy ? t("settings.overview.healthy") : t("settings.overview.degraded")}
            </StatusBadge>
          </div>

          <div className="settings-grid">
            <article className="panel metric-card">
              <span className="panel-kicker">{t("settings.overview.phase")}</span>
              <strong>{t(`bootstrap.phase.${bootstrapState.phase}`)}</strong>
              <p>{t(`settings.overview.phaseStatus.${bootstrapState.status}`)}</p>
            </article>

            <article className="panel metric-card">
              <span className="panel-kicker">{t("settings.overview.provider")}</span>
              <strong>{providerRecommendation?.current ?? preparedModel?.provider ?? t("common.auto")}</strong>
              <p>{providerRecommendation?.location ?? t("settings.overview.locationFallback")}</p>
            </article>

            <article className="panel metric-card">
              <span className="panel-kicker">{t("settings.overview.model")}</span>
              <strong>
                {preparedModel?.configExists ? t("settings.overview.modelReady") : t("settings.overview.modelMissing")}
              </strong>
              <p>{preparedModel?.modelPath ?? t("settings.overview.modelPathFallback")}</p>
            </article>
          </div>
        </article>

        <article className="panel settings-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("settings.maintenance.kicker")}</p>
              <h2 className="section-title">{t("settings.maintenance.title")}</h2>
            </div>
            <StatusBadge tone="muted">{t("settings.maintenance.localOnly")}</StatusBadge>
          </div>

          <div className="inline-grid">
            <label className="inline-field">
              <span>{t("settings.maintenance.modelVersionLabel")}</span>
              <select
                className="input-field"
                value={modelKey}
                onChange={(event) => setModelKey(event.target.value)}
              >
                <option value="voxcpm2-default">VoxCPM2</option>
                <option value="voxcpm1.5-default">VoxCPM1.5</option>
                <option value="voxcpm-0.5b-default">VoxCPM-0.5B</option>
              </select>
            </label>

            <label className="inline-field">
              <span>{t("settings.maintenance.providerLabel")}</span>
              <select
                className="input-field"
                value={providerPreference}
                onChange={(event) =>
                  setProviderPreference(event.target.value as "auto" | "huggingface" | "modelscope")
                }
              >
                <option value="auto">{t("settings.maintenance.providerAuto")}</option>
                <option value="huggingface">{t("settings.maintenance.providerHuggingFace")}</option>
                <option value="modelscope">{t("settings.maintenance.providerModelScope")}</option>
              </select>
            </label>
          </div>

          <div className="button-row">
            <button
              className="action-button action-button--secondary"
              onClick={() => {
                void onPrepareModel(modelKey, providerPreference, false);
              }}
              type="button"
            >
              {t("settings.maintenance.checkModel")}
            </button>
            <button
              className="action-button action-button--secondary"
              onClick={() => {
                void onPrepareModel(modelKey, providerPreference, true);
              }}
              type="button"
            >
              {t("settings.maintenance.prepareModel")}
            </button>
          </div>

          <div className="settings-list">
            <div className="settings-list__item">
              <strong>{t("settings.maintenance.modelPath")}</strong>
              <p>{preparedModel?.modelPath ?? t("settings.maintenance.modelPathFallback")}</p>
            </div>
            <div className="settings-list__item">
              <strong>{t("settings.maintenance.sidecarStatus")}</strong>
              <p>{sidecarStatus.reason ?? t("settings.maintenance.sidecarFallback")}</p>
            </div>
          </div>
        </article>

        <article className="panel settings-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("settings.diagnostics.kicker")}</p>
              <h2 className="section-title">{t("settings.diagnostics.title")}</h2>
            </div>
          </div>

          <div className="settings-list">
            <div className="settings-list__item">
              <strong>{t("settings.diagnostics.lastError")}</strong>
              <p>
                {bootstrapState.lastError?.message ??
                  latestFailedTask?.error?.message ??
                  t("settings.diagnostics.noError")}
              </p>
            </div>
            <div className="settings-list__item">
              <strong>{t("settings.diagnostics.taskCount")}</strong>
              <p>{t("settings.diagnostics.taskCountValue", { count: taskHistory.length })}</p>
            </div>
            <div className="settings-list__item">
              <strong>{t("settings.diagnostics.outputPath")}</strong>
              <p>{taskHistory[0]?.result?.audioPath ?? t("settings.diagnostics.outputPathFallback")}</p>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
