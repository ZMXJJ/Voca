import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
  VoiceEntry,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { listVoices } from "../lib/tauri";
import { AudioPlayer } from "./AudioPlayer";
import { CustomSelect } from "./CustomSelect";
import { IconModel, IconMicrophone, IconSparkle, IconSliders, IconPlay } from "./Icons";
import { VoiceLibrary } from "./VoiceLibrary";

type GenerationWorkspaceProps = {
  currentTask: TaskRecord | null;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  modelCatalog: ModelCatalogEntry[];
  sidecarStatus: SidecarStatus;
  taskHistory: TaskRecord[];
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmit: (payload: GenerationParams) => Promise<void>;
};

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatDuration(ms?: number) {
  if (!ms) return "0:00";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function GenerationWorkspace({
  currentTask,
  preparedModel,
  modelCatalog,
  sidecarStatus,
  taskHistory,
  onSubmit,
}: GenerationWorkspaceProps) {
  const { t } = useTranslation();
  const [targetText, setTargetText] = useState("");
  const [modelKey, setModelKey] = useState("voxcpm2-default");
  const [providerPreference] = useState<"auto" | "huggingface" | "modelscope">("auto");
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceEntry[]>([]);

  useEffect(() => {
    void listVoices().then(setVoices);
  }, []);

  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);
  const [cfgValue, setCfgValue] = useState(2.0);
  const [inferenceSteps, setInferenceSteps] = useState(10);
  const [normalize, setNormalize] = useState(true);
  const [denoise, setDenoise] = useState(true);
  const [seed, setSeed] = useState(-1);

  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: MouseEvent) => {
      if (configRef.current && !configRef.current.contains(e.target as Node)) setConfigOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [configOpen]);

  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setConfigOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [configOpen]);

  const taskIsRunning = currentTask
    ? !["succeeded", "failed", "cancelled"].includes(currentTask.status)
    : false;
  const modelReady = preparedModel?.configExists ?? false;

  const latestAudioPath = useMemo(() => {
    if (currentTask?.result?.audioPath) return currentTask.result.audioPath;
    const found = taskHistory.find((t) => t.result?.audioPath);
    return found?.result?.audioPath ?? null;
  }, [currentTask, taskHistory]);

  const handleGenerate = () => {
    if (!targetText.trim()) return;
    void onSubmit({
      mode: "voice_design",
      targetText,
      modelKey,
      providerPreference,
      controlInstruction: "",
      streaming: false,
      cfgValue,
      inferenceTimesteps: inferenceSteps,
      normalize,
      denoise,
      seed: seed >= 0 ? seed : undefined,
    });
  };

  return (
    <>
      <h1 className="studio-title">{t("studio.title")}</h1>

      <div className="text-composer">
        <textarea
          className="text-composer__input"
          value={targetText}
          onChange={(e) => setTargetText(e.target.value)}
          placeholder={t("studio.inputPlaceholder")}
          rows={6}
        />
        <div className="text-composer__divider" />
        <div className="text-composer__toolbar">
          <CustomSelect
            className="toolbar-select"
            value={modelKey}
            onChange={setModelKey}
            options={modelCatalog.map((m) => ({ value: m.modelKey, label: m.displayName }))}
            icon={<IconModel size={14} />}
          />
          <CustomSelect
            className="toolbar-select"
            value={selectedVoiceId ?? ""}
            onChange={(v) => setSelectedVoiceId(v || null)}
            options={[
              { value: "", label: t("studio.voiceSelect") },
              ...voices.map((v) => ({ value: v.id, label: v.name })),
            ]}
            icon={<IconMicrophone size={14} />}
          />
          <div className="toolbar-spacer" />
          <button
            className="toolbar-btn toolbar-btn--generate"
            disabled={!modelReady || taskIsRunning || !sidecarStatus.healthy}
            onClick={handleGenerate}
            type="button"
          >
            <IconSparkle size={16} />
            {taskIsRunning ? t("studio.generating") : t("studio.generate")}
          </button>
          <div className="config-popover" ref={configRef}>
            <button
              className={`toolbar-btn toolbar-btn--config${configOpen ? " toolbar-btn--config-active" : ""}`}
              type="button"
              onClick={() => setConfigOpen((v) => !v)}
              aria-expanded={configOpen}
            >
              <IconSliders size={18} />
            </button>

            <div className={`config-panel${configOpen ? " config-panel--open" : ""}`}>
              <div className="config-panel__header">
                <span className="config-panel__title">{t("studio.config.title")}</span>
                <button
                  className="config-panel__reset"
                  type="button"
                  onClick={() => { setCfgValue(2.0); setInferenceSteps(10); setNormalize(true); setDenoise(true); setSeed(-1); }}
                >
                  {t("studio.config.reset")}
                </button>
              </div>

              <label className="config-panel__row">
                <div className="config-panel__label-line">
                  <span>{t("studio.config.cfgScale")}</span>
                  <span className="config-panel__value">{cfgValue.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  className="config-panel__slider"
                  min={0.1}
                  max={5.0}
                  step={0.1}
                  value={cfgValue}
                  onChange={(e) => setCfgValue(Number(e.target.value))}
                />
                <span className="config-panel__range">0.1 — 5.0</span>
              </label>

              <label className="config-panel__row">
                <div className="config-panel__label-line">
                  <span>{t("studio.config.steps")}</span>
                  <span className="config-panel__value">{inferenceSteps}</span>
                </div>
                <input
                  type="range"
                  className="config-panel__slider"
                  min={1}
                  max={50}
                  step={1}
                  value={inferenceSteps}
                  onChange={(e) => setInferenceSteps(Number(e.target.value))}
                />
                <span className="config-panel__range">1 — 50</span>
              </label>

              <label className="config-panel__row">
                <div className="config-panel__label-line">
                  <span>{t("studio.config.seed")}</span>
                  <span className="config-panel__value">{seed === -1 ? t("studio.config.random") : seed}</span>
                </div>
                <input
                  type="number"
                  className="config-panel__number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  min={-1}
                  placeholder="-1"
                />
              </label>

              <div className="config-panel__divider" />

              <label className="config-panel__toggle-row">
                <span>{t("studio.config.normalize")}</span>
                <button
                  type="button"
                  className={`config-panel__switch${normalize ? " config-panel__switch--on" : ""}`}
                  onClick={() => setNormalize((v) => !v)}
                  role="switch"
                  aria-checked={normalize}
                >
                  <span className="config-panel__switch-thumb" />
                </button>
              </label>

              <label className="config-panel__toggle-row">
                <span>{t("studio.config.denoise")}</span>
                <button
                  type="button"
                  className={`config-panel__switch${denoise ? " config-panel__switch--on" : ""}`}
                  onClick={() => setDenoise((v) => !v)}
                  role="switch"
                  aria-checked={denoise}
                >
                  <span className="config-panel__switch-thumb" />
                </button>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="studio-grid">
        <VoiceLibrary
          selectedVoiceId={selectedVoiceId}
          onSelectVoice={setSelectedVoiceId}
        />

        <div className="card">
          <div className="card__header">
            <h3 className="card__title">{t("studio.generationHistory.title")}</h3>
            <span className="card__count">
              {t("studio.generationHistory.count", { count: taskHistory.length })}
            </span>
          </div>
          <div className="card__body">
            {taskHistory.length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: "13px", textAlign: "center", padding: "32px 0" }}>
                {t("studio.generationHistory.empty")}
              </p>
            ) : (
              <div className="history-list">
                {taskHistory.slice(0, 6).map((task) => (
                  <div key={task.id} className="history-item">
                    <div className="history-item__play"><IconPlay size={12} /></div>
                    <div className="history-item__info">
                      <div className="history-item__text">
                        {task.message || task.result?.audioPath || t("studio.generationHistory.untitled")}
                      </div>
                      <div className="history-item__meta">
                        {formatHistoryTime(task.createdAt)} · {formatDuration(task.result?.durationMs)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <AudioPlayer audioPath={latestAudioPath} />
    </>
  );
}
