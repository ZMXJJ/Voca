import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { getTaskPlayableAudioPath } from "../lib/historyStorage";
import { listVoices } from "../lib/tauri";
import { AudioPlayer } from "./AudioPlayer";
import { getAudioDownloadPath } from "./SettingsWorkspace";
import { CustomSelect } from "./CustomSelect";
import { IconModel, IconMicrophone, IconSparkle, IconSliders, IconPlay } from "./Icons";
import { VoiceLibrary } from "./VoiceLibrary";

type GenerationWorkspaceProps = {
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

function formatHistoryTime(
  value: string,
  language: string,
  t: (key: string, options?: Record<string, string>) => string,
) {
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

  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return t("studio.generationHistory.todayAt", { time });
  if (isYesterday) return t("studio.generationHistory.yesterdayAt", { time });
  return new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric" }).format(date);
}

function formatDuration(ms?: number) {
  if (!ms) return "0:00";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isTaskRunning(task: TaskRecord) {
  return task.status === "queued" || task.status === "running";
}

function isTaskFailed(task: TaskRecord) {
  return task.status === "failed" || task.status === "cancelled";
}

export function GenerationWorkspace({
  preparedModel,
  modelCatalog,
  sidecarStatus,
  taskHistory,
  onSubmit,
}: GenerationWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [targetText, setTargetText] = useState("");
  const [modelKey, setModelKey] = useState("voxcpm2");
  const [providerPreference] = useState<"auto" | "huggingface" | "modelscope">("auto");
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceEntry[]>([]);

  const loadVoices = useCallback(async () => {
    const nextVoices = await listVoices();
    setVoices(nextVoices);
    setSelectedVoiceId((current) => {
      if (current && nextVoices.some((voice) => voice.id === current)) return current;
      return nextVoices[0]?.id ?? null;
    });
    return nextVoices;
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);
  const [cfgValue, setCfgValue] = useState(2.0);
  const [inferenceSteps, setInferenceSteps] = useState(10);
  const [normalize, setNormalize] = useState(true);
  const [denoise, setDenoise] = useState(false);
  const [extremeClone, setExtremeClone] = useState(false);
  const [seed, setSeed] = useState(-1);
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState<string | null>(null);
  const [historyPlayNonce, setHistoryPlayNonce] = useState(0);

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

  const hasDownloadedModels = modelCatalog.length > 0;
  const modelReady = preparedModel?.configExists ?? false;
  const playableHistory = useMemo(
    () => taskHistory.filter((task) => Boolean(getTaskPlayableAudioPath(task))),
    [taskHistory],
  );
  const displayHistory = useMemo(
    () =>
      taskHistory
        .filter((task) => task.type === "generate" && (Boolean(getTaskPlayableAudioPath(task)) || isTaskRunning(task) || isTaskFailed(task))),
    [taskHistory],
  );

  useEffect(() => {
    if (modelCatalog.length === 0) return;

    const preferredModelKey = preparedModel?.modelKey;
    const nextModelKey =
      (preferredModelKey && modelCatalog.some((model) => model.modelKey === preferredModelKey)
        ? preferredModelKey
        : null) ?? modelCatalog[0]?.modelKey;

    if (nextModelKey && nextModelKey !== modelKey) {
      setModelKey(nextModelKey);
    }
  }, [modelCatalog, modelKey, preparedModel?.modelKey]);

  useEffect(() => {
    if (!selectedHistoryTaskId) {
      return;
    }
    if (!playableHistory.some((task) => task.id === selectedHistoryTaskId)) {
      setSelectedHistoryTaskId(null);
    }
  }, [playableHistory, selectedHistoryTaskId]);

  const latestAudioPath = useMemo(() => {
    if (selectedHistoryTaskId) {
      const selectedTask = playableHistory.find((task) => task.id === selectedHistoryTaskId);
      const selectedAudioPath = selectedTask ? getTaskPlayableAudioPath(selectedTask) : null;
      if (selectedAudioPath) {
        return selectedAudioPath;
      }
    }
    const found = playableHistory.find((task) => getTaskPlayableAudioPath(task));
    return found ? getTaskPlayableAudioPath(found) : null;
  }, [playableHistory, selectedHistoryTaskId]);

  const selectedHistoryTask = useMemo(() => {
    if (selectedHistoryTaskId) {
      return playableHistory.find((task) => task.id === selectedHistoryTaskId) ?? null;
    }
    return playableHistory[0] ?? null;
  }, [playableHistory, selectedHistoryTaskId]);

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === selectedVoiceId) ?? null,
    [selectedVoiceId, voices],
  );

  const [showDownloadToast, setShowDownloadToast] = useState(false);
  const downloadToastTimer = useRef<number | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimer = useRef<number | null>(null);
  const acknowledgedFailures = useRef<Set<string>>(
    new Set(taskHistory.filter((t) => t.status === "failed").map((t) => t.id)),
  );

  const handleDownloadComplete = useCallback(() => {
    setShowDownloadToast(true);
    if (downloadToastTimer.current) window.clearTimeout(downloadToastTimer.current);
    downloadToastTimer.current = window.setTimeout(() => setShowDownloadToast(false), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (downloadToastTimer.current) window.clearTimeout(downloadToastTimer.current);
      if (errorToastTimer.current) window.clearTimeout(errorToastTimer.current);
    };
  }, []);

  useEffect(() => {
    const newFailure = taskHistory.find(
      (task) => task.type === "generate" && task.status === "failed" && !acknowledgedFailures.current.has(task.id),
    );
    if (!newFailure) return;

    acknowledgedFailures.current.add(newFailure.id);
    const detail = newFailure.error?.message || newFailure.message || t("studio.generationHistory.status.failed");
    setErrorToast(detail);
    if (errorToastTimer.current) window.clearTimeout(errorToastTimer.current);
    errorToastTimer.current = window.setTimeout(() => setErrorToast(null), 6000);
  }, [taskHistory, t]);

  const downloadFileName = useMemo(() => {
    const task = selectedHistoryTask;
    if (!task) return undefined;
    const voiceName = task.voiceName?.trim() || selectedVoice?.name || "";
    const textSnippet = (task.title ?? "").slice(0, 10).trim();
    const parts = [voiceName, textSnippet].filter(Boolean);
    return parts.length > 0 ? `${parts.join("_")}.wav` : undefined;
  }, [selectedHistoryTask, selectedVoice]);

  const handleGenerate = () => {
    if (!targetText.trim()) return;
    const hasRef = Boolean(selectedVoice?.referenceAudioPath);
    const hasTranscript = Boolean(selectedVoice?.referenceTranscript?.trim());
    void onSubmit({
      mode: hasRef ? "controllable_clone" : "voice_design",
      targetText,
      modelKey,
      providerPreference,
      voiceName: selectedVoice?.name?.trim() || undefined,
      controlInstruction: extremeClone ? undefined : (selectedVoice?.description?.trim() || ""),
      referenceAudioPath: selectedVoice?.referenceAudioPath,
      promptText: selectedVoice?.referenceTranscript?.trim() || undefined,
      extremeClone: extremeClone && hasRef && hasTranscript,
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
          {hasDownloadedModels ? (
            <CustomSelect
              className="toolbar-select"
              value={modelKey}
              onChange={setModelKey}
              options={modelCatalog.map((m) => ({ value: m.modelKey, label: m.displayName }))}
              icon={<IconModel size={14} />}
            />
          ) : null}
          <CustomSelect
            className="toolbar-select"
            value={selectedVoiceId ?? ""}
            onChange={(v) => setSelectedVoiceId(v || null)}
            options={voices.map((v) => ({ value: v.id, label: v.name }))}
            icon={<IconMicrophone size={14} />}
          />
          <div className="toolbar-spacer" />
          <button
            className="toolbar-btn toolbar-btn--generate"
            disabled={!hasDownloadedModels || !modelReady || !sidecarStatus.healthy}
            onClick={handleGenerate}
            type="button"
          >
            <IconSparkle size={18} style={{ transform: "translateY(-1.5px)" }} />
            {t("studio.generate")}
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
                  onClick={() => { setCfgValue(2.0); setInferenceSteps(10); setNormalize(true); setDenoise(false); setExtremeClone(false); setSeed(-1); }}
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

              <div className="config-panel__divider" />

              <label className="config-panel__toggle-row">
                <span>{t("studio.config.extremeClone")}</span>
                <button
                  type="button"
                  className={`config-panel__switch${extremeClone ? " config-panel__switch--on" : ""}`}
                  onClick={() => setExtremeClone((v) => !v)}
                  role="switch"
                  aria-checked={extremeClone}
                >
                  <span className="config-panel__switch-thumb" />
                </button>
              </label>
              <p className="config-panel__hint">{t("studio.config.extremeCloneHint")}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="studio-grid">
        <VoiceLibrary
          voices={voices}
          selectedVoiceId={selectedVoiceId}
          onSelectVoice={setSelectedVoiceId}
          onReloadVoices={loadVoices}
        />

        <div className="card">
          <div className="card__header">
            <h3 className="card__title">{t("studio.generationHistory.title")}</h3>
            <span className="card__count">
              {t("studio.generationHistory.count", { count: displayHistory.length })}
            </span>
          </div>
          <div className="card__body">
            {displayHistory.length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: "13px", textAlign: "center", padding: "32px 0" }}>
                {t("studio.generationHistory.empty")}
              </p>
            ) : (
              <div className="history-list history-list--compact">
                {displayHistory.map((task) => {
                  const audioPath = getTaskPlayableAudioPath(task);
                  const isPlayable = Boolean(audioPath);
                  const isPending = isTaskRunning(task);
                  const isFailed = isTaskFailed(task);
                  const statusLabel = (isPending || isFailed) ? t(`studio.generationHistory.status.${task.status}`) : null;
                  const statusTone = isFailed ? "status-badge--error" : task.status === "running" ? "status-badge--accent" : "status-badge--muted";
                  const voiceLabel = task.voiceName?.trim() || null;
                  const metaParts = [
                    formatHistoryTime(task.createdAt, i18n.resolvedLanguage ?? i18n.language, t),
                    isPlayable ? formatDuration(task.result?.durationMs) : null,
                    voiceLabel,
                  ].filter(Boolean);

                  return (
                    <div
                      key={task.id}
                      className={`history-item${selectedHistoryTaskId === task.id ? " history-item--selected" : ""}${!isPlayable ? " history-item--inactive" : ""}`}
                      onClick={() => {
                        if (!isPlayable) return;
                        setSelectedHistoryTaskId(task.id);
                        setHistoryPlayNonce((value) => value + 1);
                      }}
                    >
                      <button
                        className="history-item__play"
                        type="button"
                        disabled={!isPlayable}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!isPlayable) return;
                          setSelectedHistoryTaskId(task.id);
                          setHistoryPlayNonce((value) => value + 1);
                        }}
                        aria-label={`Play ${task.title || task.message || t("studio.generationHistory.untitled")}`}
                      >
                        <IconPlay size={12} />
                      </button>
                      <div className="history-item__content">
                        <div className="history-item__info">
                          <div className="history-item__text">
                            {task.title || task.message || task.result?.audioPath || t("studio.generationHistory.untitled")}
                          </div>
                          <div className="history-item__meta">{metaParts.join(" · ")}</div>
                        </div>
                        {statusLabel ? (
                          <span className={`status-badge history-item__badge history-item__status ${statusTone}`}>
                            {statusLabel}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <AudioPlayer
        audioPath={latestAudioPath}
        autoPlay={Boolean(selectedHistoryTaskId)}
        playNonce={historyPlayNonce}
        downloadName={downloadFileName}
        defaultDirectory={getAudioDownloadPath()}
        onDownloadComplete={handleDownloadComplete}
      />

      {showDownloadToast && (
        <div className="download-toast">{t("generation.downloadComplete")}</div>
      )}

      {errorToast && (
        <div className="error-toast" onClick={() => setErrorToast(null)}>
          <span className="error-toast__label">{t("studio.generationHistory.status.failed")}</span>
          <span className="error-toast__detail">{errorToast}</span>
        </div>
      )}
    </>
  );
}
