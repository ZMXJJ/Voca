import { useMemo, useState } from "react";
import type {
  GenerationParams,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "./StatusBadge";

type GenerationWorkspaceProps = {
  currentTask: TaskRecord | null;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  sidecarStatus: SidecarStatus;
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmit: (payload: GenerationParams) => Promise<void>;
};

function getTaskTone(task: TaskRecord | null) {
  if (!task) {
    return "muted";
  }

  switch (task.status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "queued":
      return "warning";
    case "cancelled":
      return "muted";
    default:
      return "muted";
  }
}

export function GenerationWorkspace({
  currentTask,
  providerRecommendation,
  preparedModel,
  sidecarStatus,
  onPrepareModel,
  onSubmit,
}: GenerationWorkspaceProps) {
  const { t } = useTranslation();
  const [targetText, setTargetText] = useState("");
  const [controlInstruction, setControlInstruction] = useState("");
  const [referenceAudioPath, setReferenceAudioPath] = useState("");
  const [promptText, setPromptText] = useState("");
  const [modelKey, setModelKey] = useState("voxcpm2-default");
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">(
    "auto",
  );
  const [cfgValue, setCfgValue] = useState(2);
  const [inferenceTimesteps, setInferenceTimesteps] = useState(10);
  const [normalize, setNormalize] = useState(true);
  const [denoise, setDenoise] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [textTouched, setTextTouched] = useState(false);
  const [instructionTouched, setInstructionTouched] = useState(false);

  const effectiveTargetText = textTouched ? targetText : t("generation.defaults.targetText");
  const effectiveControlInstruction = instructionTouched
    ? controlInstruction
    : t("generation.defaults.controlInstruction");

  const taskIsRunning = currentTask
    ? !["succeeded", "failed", "cancelled"].includes(currentTask.status)
    : false;
  const modelReady = preparedModel?.configExists ?? false;
  const taskTone = getTaskTone(currentTask);
  const activeProvider = providerRecommendation?.current ?? preparedModel?.provider ?? "unknown";

  const resultSummary = useMemo(() => {
    if (!currentTask) {
      return {
        title: t("generation.result.noResultTitle"),
        body: t("generation.result.noResultBody"),
      };
    }

    if (currentTask.result?.audioPath) {
      return {
        title: t("generation.result.latestResultTitle"),
        body: currentTask.result.audioPath,
      };
    }

    return {
      title: currentTask.message ?? t("generation.result.taskCreatedTitle"),
      body: t("generation.result.taskCreatedBody"),
    };
  }, [currentTask, t]);

  return (
    <div className="workspace-grid">
      <section className="composer-column">
        <article className="panel section-panel">
          <div className="section-head">
            <div>
              <p className="panel-kicker">{t("generation.reference.kicker")}</p>
              <h2 className="section-title">{t("generation.reference.title")}</h2>
            </div>
            <StatusBadge tone="muted">{t("generation.reference.badge")}</StatusBadge>
          </div>

          <div className="reference-grid">
            <div className="dropzone">
              <div className="dropzone__icon">♪</div>
              <strong>{t("generation.reference.dropzoneTitle")}</strong>
              <p>{t("generation.reference.dropzoneBody")}</p>
            </div>

            <div className="reference-file-card">
              <label className="field-label" htmlFor="referenceAudioPath">
                {t("generation.reference.pathLabel")}
              </label>
              <input
                id="referenceAudioPath"
                className="input-field"
                value={referenceAudioPath}
                onChange={(event) => setReferenceAudioPath(event.target.value)}
                placeholder={t("generation.reference.pathPlaceholder")}
              />
              <p className="field-note">{t("generation.reference.pathNote")}</p>
            </div>
          </div>
        </article>

        <article className="panel section-panel">
          <div className="section-head">
            <div>
              <p className="panel-kicker">{t("generation.target.kicker")}</p>
              <h2 className="section-title">{t("generation.target.title")}</h2>
            </div>
            <StatusBadge tone="accent">{effectiveTargetText.length} / 2000</StatusBadge>
          </div>

          <textarea
            className="textarea-field"
            value={effectiveTargetText}
            onChange={(event) => {
              setTextTouched(true);
              setTargetText(event.target.value);
            }}
            rows={8}
            placeholder={t("generation.target.placeholder")}
          />

          <div className="helper-row">
            <button
              className="helper-button"
              onClick={() => {
                setTextTouched(true);
                setTargetText("");
              }}
            >
              {t("generation.target.clear")}
            </button>
            <button
              className="helper-button"
              onClick={() => {
                setTextTouched(true);
                setTargetText(t("generation.target.sampleText"));
              }}
            >
              {t("generation.target.loadSample")}
            </button>
          </div>
        </article>

        <article className="panel section-panel">
          <div className="section-head">
            <div>
              <p className="panel-kicker">{t("generation.voice.kicker")}</p>
              <h2 className="section-title">{t("generation.voice.title")}</h2>
            </div>
            <StatusBadge tone={modelReady ? "success" : "warning"}>
              {modelReady ? t("generation.voice.modelReady") : t("generation.voice.modelNeedPrepare")}
            </StatusBadge>
          </div>

          <div className="inline-grid">
            <label className="inline-field">
              <span>{t("generation.voice.controlInstructionLabel")}</span>
              <input
                className="input-field"
                value={effectiveControlInstruction}
                onChange={(event) => {
                  setInstructionTouched(true);
                  setControlInstruction(event.target.value);
                }}
                placeholder={t("generation.voice.controlInstructionPlaceholder")}
              />
            </label>

            <label className="inline-field">
              <span>{t("generation.voice.promptTextLabel")}</span>
              <input
                className="input-field"
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder={t("generation.voice.promptTextPlaceholder")}
              />
            </label>

            <label className="inline-field">
              <span>{t("generation.voice.modelVersionLabel")}</span>
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
              <span>{t("generation.voice.providerLabel")}</span>
              <select
                className="input-field"
                value={providerPreference}
                onChange={(event) =>
                  setProviderPreference(event.target.value as "auto" | "huggingface" | "modelscope")
                }
              >
                <option value="auto">{t("generation.voice.providerAuto")}</option>
                <option value="huggingface">{t("generation.voice.providerHuggingFace")}</option>
                <option value="modelscope">{t("generation.voice.providerModelScope")}</option>
              </select>
            </label>
          </div>

          <div className="prepare-box">
            <div>
              <strong>{t("generation.voice.recommendedSource")}</strong>
              <p>
                {providerRecommendation
                  ? `${providerRecommendation.current}${
                      providerRecommendation.location ? ` · ${providerRecommendation.location}` : ""
                    }`
                  : t("generation.voice.recommendedSourceFallback")}
              </p>
            </div>
            <div>
              <strong>{t("generation.voice.modelPath")}</strong>
              <p>{preparedModel?.modelPath ?? t("generation.voice.modelPathFallback")}</p>
            </div>
          </div>

          <div className="button-row">
            <button
              className="action-button action-button--secondary"
              onClick={() => {
                void onPrepareModel(modelKey, providerPreference, false);
              }}
            >
              {t("generation.voice.checkModel")}
            </button>
            <button
              className="action-button action-button--secondary"
              onClick={() => {
                void onPrepareModel(modelKey, providerPreference, true);
              }}
            >
              {t("generation.voice.prepareModel")}
            </button>
          </div>

          <div className="accordion-shell">
            <button
              className="accordion-button"
              onClick={() => setShowAdvanced((value) => !value)}
            >
              <span>{t("generation.voice.advancedTitle")}</span>
              <span>{showAdvanced ? t("generation.voice.collapse") : t("generation.voice.expand")}</span>
            </button>

            {showAdvanced && (
              <div className="advanced-grid">
                <div className="slider-block">
                  <div className="slider-block__header">
                    <label htmlFor="cfgValue">{t("generation.voice.cfgLabel")}</label>
                    <span>{cfgValue.toFixed(1)}</span>
                  </div>
                  <input
                    id="cfgValue"
                    type="range"
                    min="1"
                    max="10"
                    step="0.5"
                    value={cfgValue}
                    onChange={(event) => setCfgValue(Number(event.target.value))}
                  />
                  <p>{t("generation.voice.cfgHelp")}</p>
                </div>

                <div className="slider-block">
                  <div className="slider-block__header">
                    <label htmlFor="timesteps">{t("generation.voice.timestepsLabel")}</label>
                    <span>{inferenceTimesteps}</span>
                  </div>
                  <input
                    id="timesteps"
                    type="range"
                    min="10"
                    max="50"
                    step="5"
                    value={inferenceTimesteps}
                    onChange={(event) => setInferenceTimesteps(Number(event.target.value))}
                  />
                  <p>{t("generation.voice.timestepsHelp")}</p>
                </div>

                <div className="toggle-row">
                  <label className="toggle-pill">
                    <input
                      type="checkbox"
                      checked={denoise}
                      onChange={(event) => setDenoise(event.target.checked)}
                    />
                    <span>{t("generation.voice.denoise")}</span>
                  </label>

                  <label className="toggle-pill">
                    <input
                      type="checkbox"
                      checked={normalize}
                      onChange={(event) => setNormalize(event.target.checked)}
                    />
                    <span>{t("generation.voice.normalize")}</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </article>
      </section>

      <aside className="results-column">
        <article className="panel action-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("generation.action.kicker")}</p>
              <h2 className="section-title">{t("generation.action.title")}</h2>
            </div>
            <StatusBadge tone={sidecarStatus.healthy ? "success" : "warning"}>
              {sidecarStatus.healthy
                ? t("generation.action.serviceReady")
                : t("generation.action.servicePreparing")}
            </StatusBadge>
          </div>

          <p className="action-card__copy">{t("generation.action.copy")}</p>

          <button
            className="action-button action-button--primary action-button--full"
            disabled={!modelReady || taskIsRunning}
            onClick={() => {
              void onSubmit({
                mode: "voice_design",
                targetText: effectiveTargetText,
                modelKey,
                providerPreference,
                controlInstruction: effectiveControlInstruction,
                referenceAudioPath: referenceAudioPath || undefined,
                promptText: promptText || undefined,
                cfgValue,
                inferenceTimesteps,
                normalize,
                denoise,
                streaming: false,
              });
            }}
          >
            {taskIsRunning ? t("generation.action.running") : t("generation.action.start")}
          </button>

          <div className="action-card__foot">
            <span>
              {t("generation.action.sourcePrefix")}
              {activeProvider}
            </span>
            <span>{modelReady ? t("generation.action.modelReady") : t("generation.action.modelPending")}</span>
          </div>
        </article>

        <article className="panel result-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("generation.result.kicker")}</p>
              <h2 className="section-title">{t("generation.result.title")}</h2>
            </div>
            <StatusBadge tone={taskTone}>
              {t(`common.taskStatus.${currentTask?.status ?? "idle"}`)}
            </StatusBadge>
          </div>

          <div className="result-placeholder">
            <div className="result-placeholder__icon">◌</div>
            <strong>{resultSummary.title}</strong>
            <p>{resultSummary.body}</p>
          </div>

          {currentTask?.progress !== undefined && (
            <div className="mini-progress">
              <div className="mini-progress__bar">
                <div
                  className="mini-progress__fill"
                  style={{ width: `${Math.max(6, currentTask.progress)}%` }}
                />
              </div>
              <span>{currentTask.progress}%</span>
            </div>
          )}

          {currentTask?.result && (
            <dl className="result-meta">
              <div>
                <dt>{t("generation.result.audioPath")}</dt>
                <dd>{currentTask.result.audioPath ?? t("generation.result.pathFallback")}</dd>
              </div>
              <div>
                <dt>{t("generation.result.sampleRate")}</dt>
                <dd>{currentTask.result.sampleRate ?? "--"}</dd>
              </div>
              <div>
                <dt>{t("generation.result.duration")}</dt>
                <dd>
                  {currentTask.result.durationMs ? `${Math.round(currentTask.result.durationMs)} ms` : "--"}
                </dd>
              </div>
            </dl>
          )}

          {currentTask && (
            <details className="debug-details">
              <summary>{t("generation.result.rawResponse")}</summary>
              <pre>{JSON.stringify(currentTask, null, 2)}</pre>
            </details>
          )}
        </article>

        <article className="panel trust-card">
          <div className="trust-card__icon">⌘</div>
          <div>
            <h3>{t("generation.trust.title")}</h3>
            <p>{t("generation.trust.body")}</p>
          </div>
        </article>

        <div className="metrics-grid">
          <article className="panel metric-card">
            <span className="panel-kicker">{t("generation.metrics.serviceStatus")}</span>
            <strong>{sidecarStatus.running ? t("generation.metrics.running") : t("generation.metrics.offline")}</strong>
            <p>{sidecarStatus.reason ?? t("generation.metrics.waitingSync")}</p>
          </article>

          <article className="panel metric-card">
            <span className="panel-kicker">{t("generation.metrics.currentPhase")}</span>
            <strong>{preparedModel?.provider ?? t("common.auto")}</strong>
            <p>
              {preparedModel?.configExists
                ? t("generation.metrics.configReady")
                : t("generation.metrics.configMissing")}
            </p>
          </article>
        </div>
      </aside>
    </div>
  );
}
