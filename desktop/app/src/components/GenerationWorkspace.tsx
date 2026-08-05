import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GenerationParams,
  ModelCatalogEntry,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
  VoiceEntry,
  WorkEntry,
} from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { getTaskPlayableAudioPath } from "../lib/taskUtils";
import { AudioPlayer } from "./AudioPlayer";
import { getAudioDownloadPath } from "../lib/audioDownloadPath";
import { CustomSelect } from "./CustomSelect";
import { IconModel, IconMicrophone, IconSparkle, IconSliders, IconPlay } from "./Icons";
import { VoiceLibrary } from "./VoiceLibrary";

type GenerationWorkspaceProps = {
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  modelCatalog: ModelCatalogEntry[];
  sidecarStatus: SidecarStatus;
  /**
   * In-flight / failed generate tasks of the current session. Successful
   * generations are persisted server-side and arrive through ``works``.
   */
  sessionTasks: TaskRecord[];
  works: WorkEntry[];
  /**
   * Voice library state is owned by the parent (``WorkspacePage``) so it
   * survives Studio ↔ Settings tab switches without re-fetching from the
   * sidecar — that round-trip used to be the dominant per-click cost on
   * Windows.
   */
  voices: VoiceEntry[];
  selectedVoiceId: string | null;
  /** Params carried from the works library's "reuse" action. */
  prefill: GenerationParams | null;
  onPrefillConsumed: () => void;
  onSelectVoice: (voiceId: string | null) => void;
  onReloadVoices: () => Promise<VoiceEntry[]>;
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  onSubmit: (payload: GenerationParams) => Promise<void>;
};

type HistoryDisplayItem =
  | { kind: "task"; id: string; createdAt: string; task: TaskRecord }
  | { kind: "work"; id: string; createdAt: string; work: WorkEntry };

const MINI_HISTORY_LIMIT = 20;

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

function formatDuration(ms?: number | null) {
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

function getItemAudioPath(item: HistoryDisplayItem): string | null {
  if (item.kind === "work") {
    return item.work.audioPath;
  }
  return getTaskPlayableAudioPath(item.task);
}

export function GenerationWorkspace({
  preparedModel,
  modelCatalog,
  sidecarStatus,
  sessionTasks,
  works,
  voices,
  selectedVoiceId,
  prefill,
  onPrefillConsumed,
  onSelectVoice,
  onReloadVoices,
  onSubmit,
}: GenerationWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [targetText, setTargetText] = useState("");
  const [modelKey, setModelKey] = useState("voxcpm2");
  const [providerPreference] = useState<"auto" | "huggingface" | "modelscope">("auto");

  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);
  const [cfgValue, setCfgValue] = useState(2.0);
  const [inferenceSteps, setInferenceSteps] = useState(10);
  const [normalize, setNormalize] = useState(true);
  const [denoise, setDenoise] = useState(false);
  const [extremeClone, setExtremeClone] = useState(false);
  const [selectedHistoryItemId, setSelectedHistoryItemId] = useState<string | null>(null);
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

  // Merge in-flight/failed session tasks with the persisted works into one
  // display list. Works win on id collision — a task that just succeeded may
  // briefly coexist with the work row it produced.
  const displayHistory = useMemo<HistoryDisplayItem[]>(() => {
    const workIds = new Set(works.map((work) => work.id));
    const taskItems: HistoryDisplayItem[] = sessionTasks
      .filter(
        (task) =>
          task.type === "generate" &&
          !workIds.has(task.id) &&
          (isTaskRunning(task) || isTaskFailed(task) || Boolean(getTaskPlayableAudioPath(task))),
      )
      .map((task) => ({ kind: "task", id: task.id, createdAt: task.createdAt, task }));
    const workItems: HistoryDisplayItem[] = works.map((work) => ({
      kind: "work",
      id: work.id,
      createdAt: work.createdAt,
      work,
    }));
    return [...taskItems, ...workItems]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, MINI_HISTORY_LIMIT);
  }, [sessionTasks, works]);

  const playableHistory = useMemo(
    () => displayHistory.filter((item) => Boolean(getItemAudioPath(item))),
    [displayHistory],
  );

  useEffect(() => {
    if (!selectedHistoryItemId) {
      return;
    }
    if (!playableHistory.some((item) => item.id === selectedHistoryItemId)) {
      setSelectedHistoryItemId(null);
    }
  }, [playableHistory, selectedHistoryItemId]);

  const selectedHistoryItem = useMemo(() => {
    if (selectedHistoryItemId) {
      return playableHistory.find((item) => item.id === selectedHistoryItemId) ?? null;
    }
    return playableHistory[0] ?? null;
  }, [playableHistory, selectedHistoryItemId]);

  const latestAudioPath = selectedHistoryItem ? getItemAudioPath(selectedHistoryItem) : null;

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === selectedVoiceId) ?? null,
    [selectedVoiceId, voices],
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

  // Prefill the composer from a works-library "reuse" action. Params the
  // legacy import couldn't recover stay at their defaults.
  useEffect(() => {
    if (!prefill) return;
    setTargetText(prefill.targetText);
    if (prefill.modelKey && modelCatalog.some((model) => model.modelKey === prefill.modelKey)) {
      setModelKey(prefill.modelKey);
    }
    setCfgValue(prefill.cfgValue ?? 2.0);
    setInferenceSteps(prefill.inferenceTimesteps ?? 10);
    setNormalize(prefill.normalize ?? true);
    setDenoise(prefill.denoise ?? false);
    setExtremeClone(Boolean(prefill.extremeClone));
    const matchedVoice =
      (prefill.voiceId ? voices.find((voice) => voice.id === prefill.voiceId) : null) ??
      (prefill.voiceName ? voices.find((voice) => voice.name === prefill.voiceName) : null);
    if (matchedVoice) {
      onSelectVoice(matchedVoice.id);
    }
    onPrefillConsumed();
  }, [modelCatalog, onPrefillConsumed, onSelectVoice, prefill, voices]);

  const [showDownloadToast, setShowDownloadToast] = useState(false);
  const downloadToastTimer = useRef<number | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimer = useRef<number | null>(null);
  const acknowledgedFailures = useRef<Set<string>>(
    new Set(sessionTasks.filter((task) => task.status === "failed").map((task) => task.id)),
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
    const newFailure = sessionTasks.find(
      (task) => task.type === "generate" && task.status === "failed" && !acknowledgedFailures.current.has(task.id),
    );
    if (!newFailure) return;

    acknowledgedFailures.current.add(newFailure.id);
    const detail = newFailure.error?.message || newFailure.message || t("studio.generationHistory.status.failed");
    setErrorToast(detail);
    if (errorToastTimer.current) window.clearTimeout(errorToastTimer.current);
    errorToastTimer.current = window.setTimeout(() => setErrorToast(null), 6000);
  }, [sessionTasks, t]);

  const downloadFileName = useMemo(() => {
    const item = selectedHistoryItem;
    if (!item) return undefined;
    const voiceName =
      (item.kind === "work" ? item.work.voiceName?.trim() : item.task.voiceName?.trim()) ||
      selectedVoice?.name ||
      "";
    const titleSource = item.kind === "work" ? item.work.title : item.task.title ?? "";
    const textSnippet = (titleSource ?? "").slice(0, 10).trim();
    const parts = [voiceName, textSnippet].filter(Boolean);
    return parts.length > 0 ? `${parts.join("_")}.wav` : undefined;
  }, [selectedHistoryItem, selectedVoice]);

  const handleGenerate = () => {
    if (!targetText.trim()) return;
    const hasRef = Boolean(selectedVoice?.referenceAudioPath);
    const hasTranscript = Boolean(selectedVoice?.referenceTranscript?.trim());
    void onSubmit({
      mode: hasRef ? "controllable_clone" : "voice_design",
      targetText,
      modelKey,
      providerPreference,
      voiceId: selectedVoice?.id,
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
            onChange={(v) => onSelectVoice(v || null)}
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
                  onClick={() => { setCfgValue(2.0); setInferenceSteps(10); setNormalize(true); setDenoise(false); setExtremeClone(false); }}
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
          onSelectVoice={onSelectVoice}
          onReloadVoices={onReloadVoices}
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
                {displayHistory.map((item) => {
                  const audioPath = getItemAudioPath(item);
                  const isPlayable = Boolean(audioPath);
                  const isPending = item.kind === "task" && isTaskRunning(item.task);
                  const isFailed = item.kind === "task" && isTaskFailed(item.task);
                  const statusLabel = (isPending || isFailed) && item.kind === "task"
                    ? t(`studio.generationHistory.status.${item.task.status}`)
                    : null;
                  const statusTone = isFailed
                    ? "status-badge--error"
                    : item.kind === "task" && item.task.status === "running"
                      ? "status-badge--accent"
                      : "status-badge--muted";
                  const voiceLabel =
                    (item.kind === "work" ? item.work.voiceName?.trim() : item.task.voiceName?.trim()) || null;
                  const durationMs =
                    item.kind === "work" ? item.work.durationMs : item.task.result?.durationMs;
                  const titleText =
                    item.kind === "work"
                      ? item.work.title
                      : item.task.title || item.task.message || t("studio.generationHistory.untitled");
                  const metaParts = [
                    formatHistoryTime(item.createdAt, i18n.resolvedLanguage ?? i18n.language, t),
                    isPlayable ? formatDuration(durationMs) : null,
                    voiceLabel,
                  ].filter(Boolean);

                  return (
                    <div
                      key={item.id}
                      className={`history-item${selectedHistoryItemId === item.id ? " history-item--selected" : ""}${!isPlayable ? " history-item--inactive" : ""}`}
                      onClick={() => {
                        if (!isPlayable) return;
                        setSelectedHistoryItemId(item.id);
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
                          setSelectedHistoryItemId(item.id);
                          setHistoryPlayNonce((value) => value + 1);
                        }}
                        aria-label={`Play ${titleText}`}
                      >
                        <IconPlay size={12} />
                      </button>
                      <div className="history-item__content">
                        <div className="history-item__info">
                          <div className="history-item__text">{titleText}</div>
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
        autoPlay={Boolean(selectedHistoryItemId)}
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
