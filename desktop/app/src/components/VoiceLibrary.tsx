import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceCreatePayload, VoiceEntry } from "@voca/contracts";
import { createAsrTask, createVoice, deleteVoice, getTask, pickAudioFile, updateVoice } from "../lib/tauri";
import { IconUpload } from "./Icons";

type VoiceLibraryProps = {
  voices: VoiceEntry[];
  selectedVoiceId: string | null;
  onSelectVoice: (voiceId: string) => void;
  onReloadVoices: () => Promise<VoiceEntry[]>;
};

function chunkPairs<T>(arr: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < arr.length; i += 2) {
    rows.push(arr.slice(i, i + 2));
  }
  return rows;
}

const AVATAR_COLORS = ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#4f46e5", "#7c3aed"];

const EMPTY_VOICE_FORM: VoiceCreatePayload = {
  name: "",
  language: "中文",
  description: "",
  referenceAudioPath: undefined,
  referenceTranscript: "",
  transcriptLanguage: undefined,
};

function voiceMetaLabel(voice: VoiceEntry, t: (key: string) => string) {
  const sourceLabel =
    voice.sourceType === "builtin"
      ? t("studio.voiceLibrary.builtin")
      : t("studio.voiceLibrary.custom");
  const durationText = voice.durationSeconds != null ? ` · ${voice.durationSeconds.toFixed(1)}s` : "";
  return `${voice.language} · ${sourceLabel}${durationText}`;
}

function displayAudioName(path?: string) {
  if (!path) return null;
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function formatActionError(prefix: string, error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return `${prefix} ${error.message}`;
  }
  if (typeof error === "string" && error.trim()) {
    return `${prefix} ${error}`;
  }
  return prefix;
}

export function VoiceLibrary({
  voices,
  selectedVoiceId,
  onSelectVoice,
  onReloadVoices,
}: VoiceLibraryProps) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<VoiceCreatePayload>(EMPTY_VOICE_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [transcribingCreateAudio, setTranscribingCreateAudio] = useState(false);
  const [createTranscriptError, setCreateTranscriptError] = useState<string | null>(null);
  const [detailVoiceId, setDetailVoiceId] = useState<string | null>(null);
  const [detailForm, setDetailForm] = useState({
    name: "",
    language: "",
    description: "",
    referenceTranscript: "",
    transcriptLanguage: "",
  });
  const [detailError, setDetailError] = useState<string | null>(null);
  const [savingDetail, setSavingDetail] = useState(false);
  const [deletingDetail, setDeletingDetail] = useState(false);

  const rows = chunkPairs(voices);
  const detailVoice = useMemo(
    () => voices.find((voice) => voice.id === detailVoiceId) ?? null,
    [detailVoiceId, voices],
  );

  useEffect(() => {
    if (!detailVoiceId) return;
    if (!detailVoice) {
      setDetailVoiceId(null);
      return;
    }
    setDetailForm({
      name: detailVoice.name,
      language: detailVoice.language,
      description: detailVoice.description,
      referenceTranscript: detailVoice.referenceTranscript ?? "",
      transcriptLanguage: detailVoice.transcriptLanguage ?? "",
    });
    setDetailError(null);
  }, [detailVoice, detailVoiceId]);

  const validateVoiceForm = (payload: VoiceCreatePayload) => {
    if (!payload.name.trim()) return t("studio.voiceLibrary.validationName");
    if (!payload.language.trim()) return t("studio.voiceLibrary.validationLanguage");
    if (!payload.description.trim()) return t("studio.voiceLibrary.validationDescription");
    return null;
  };

  const pollTaskUntilFinished = async (taskId: string) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const task = await getTask(taskId);
      if (task && ["succeeded", "failed", "cancelled"].includes(task.status)) {
        return task;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    throw new Error("ASR task timed out");
  };

  const handlePickReferenceAudio = async () => {
    const selectedPath = await pickAudioFile();
    if (!selectedPath) return;
    setCreateTranscriptError(null);
    setCreateForm((current) => ({
      ...current,
      referenceAudioPath: selectedPath,
      referenceTranscript: "",
      transcriptLanguage: undefined,
    }));

    setTranscribingCreateAudio(true);
    try {
      const task = await createAsrTask({
        audioPath: selectedPath,
        modelKey: "sensevoice_small",
      });
      const finishedTask = await pollTaskUntilFinished(task.id);
      if (finishedTask.status !== "succeeded") {
        throw new Error(finishedTask.error?.message || finishedTask.message || "ASR task failed");
      }

      setCreateForm((current) => ({
        ...current,
        referenceAudioPath: selectedPath,
        referenceTranscript: finishedTask.result?.transcript ?? "",
        transcriptLanguage: finishedTask.result?.transcriptLanguage ?? "auto",
      }));
    } catch (error) {
      setCreateTranscriptError(formatActionError(t("studio.voiceLibrary.transcribeFailed"), error));
    } finally {
      setTranscribingCreateAudio(false);
    }
  };

  const handleCreateVoice = async () => {
    const validationError = validateVoiceForm(createForm);
    if (validationError) {
      setCreateError(validationError);
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const created = await createVoice({
        name: createForm.name.trim(),
        language: createForm.language.trim(),
        description: createForm.description.trim(),
        referenceAudioPath: createForm.referenceAudioPath?.trim() || undefined,
        referenceTranscript: createForm.referenceTranscript?.trim() || undefined,
        transcriptLanguage: createForm.transcriptLanguage?.trim() || undefined,
      });

      await onReloadVoices();
      onSelectVoice(created.id);
      setCreateOpen(false);
      setCreateForm(EMPTY_VOICE_FORM);
    } catch (error) {
      setCreateError(formatActionError(t("studio.voiceLibrary.createFailed"), error));
    } finally {
      setCreating(false);
    }
  };

  const handleSaveVoice = async () => {
    if (!detailVoice) return;
    const validationError = validateVoiceForm({
      ...detailForm,
      referenceAudioPath: detailVoice.referenceAudioPath,
    });
    if (validationError) {
      setDetailError(validationError);
      return;
    }

    setSavingDetail(true);
    setDetailError(null);
    try {
      await updateVoice(detailVoice.id, {
        name: detailForm.name.trim(),
        language: detailForm.language.trim(),
        description: detailForm.description.trim(),
        referenceTranscript: detailForm.referenceTranscript.trim(),
        transcriptLanguage: detailForm.transcriptLanguage.trim() || undefined,
      });

      await onReloadVoices();
      setDetailVoiceId(null);
    } catch (error) {
      setDetailError(formatActionError(t("studio.voiceLibrary.updateFailed"), error));
    } finally {
      setSavingDetail(false);
    }
  };

  const handleDeleteVoice = async () => {
    if (!detailVoice) return;
    const confirmed = window.confirm(
      t("studio.voiceLibrary.deleteConfirm", { name: detailVoice.name }),
    );
    if (!confirmed) return;

    setDeletingDetail(true);
    setDetailError(null);
    try {
      await deleteVoice(detailVoice.id);
      await onReloadVoices();
      setDetailVoiceId(null);
    } catch (error) {
      setDetailError(formatActionError(t("studio.voiceLibrary.deleteFailed"), error));
    } finally {
      setDeletingDetail(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card__header">
          <h3 className="card__title">{t("studio.voiceLibrary.title")}</h3>
          <button
            className="btn btn--primary-small"
            type="button"
            onClick={() => {
              setCreateError(null);
              setCreateTranscriptError(null);
              setCreateForm(EMPTY_VOICE_FORM);
              setCreateOpen(true);
            }}
          >
            <IconUpload size={10} /> {t("studio.voiceLibrary.upload")}
          </button>
        </div>
        <div className="card__body">
          {voices.length === 0 ? (
            <p className="voice-library__empty">{t("studio.voiceLibrary.empty")}</p>
          ) : (
            <div className="voice-grid">
              {rows.map((row, ri) => (
                <div key={ri} className="voice-grid__row">
                  {row.map((voice, vi) => (
                    <div
                      key={voice.id}
                      className={`voice-item${selectedVoiceId === voice.id ? " voice-item--selected" : ""}`}
                      onClick={() => onSelectVoice(voice.id)}
                    >
                      <div
                        className="voice-item__avatar"
                        style={{ background: AVATAR_COLORS[(ri * 2 + vi) % AVATAR_COLORS.length] }}
                      />
                      <div className="voice-item__content">
                        <div className="voice-item__name-row">
                          <div className="voice-item__name">{voice.name}</div>
                          <button
                            type="button"
                            className="voice-item__detail"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDetailVoiceId(voice.id);
                            }}
                          >
                            {t("studio.voiceLibrary.details")}
                          </button>
                        </div>
                        <div className="voice-item__meta">{voiceMetaLabel(voice, t)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {createOpen ? (
        <div className="voice-modal__overlay" onClick={() => {
          setCreateTranscriptError(null);
          setCreateOpen(false);
        }}>
          <div className="voice-modal" onClick={(event) => event.stopPropagation()}>
            <div className="voice-modal__header">
              <h3 className="voice-modal__title">{t("studio.voiceLibrary.uploadTitle")}</h3>
              <button
                type="button"
                className="voice-modal__close"
                onClick={() => {
                  setCreateTranscriptError(null);
                  setCreateOpen(false);
                }}
                aria-label={t("studio.voiceLibrary.close")}
              >
                ×
              </button>
            </div>

            <div className="voice-modal__body">
              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.name")}</span>
                <input
                  className="voice-form__input"
                  value={createForm.name}
                  onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.language")}</span>
                <input
                  className="voice-form__input"
                  value={createForm.language}
                  onChange={(event) => setCreateForm((current) => ({ ...current, language: event.target.value }))}
                />
              </label>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.description")}</span>
                <textarea
                  className="voice-form__textarea"
                  value={createForm.description}
                  onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder={t("studio.voiceLibrary.descriptionPlaceholder")}
                  rows={5}
                />
              </label>

              <div className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.referenceAudio")}</span>
                <div className="voice-form__upload-row">
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => void handlePickReferenceAudio()}
                  >
                    {t("studio.voiceLibrary.chooseReferenceAudio")}
                  </button>
                  {createForm.referenceAudioPath ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() =>
                        setCreateForm((current) => ({
                          ...current,
                          referenceAudioPath: undefined,
                          referenceTranscript: "",
                          transcriptLanguage: undefined,
                        }))
                      }
                    >
                      {t("studio.voiceLibrary.clearReferenceAudio")}
                    </button>
                  ) : null}
                </div>
                <div className="voice-form__help">{t("studio.voiceLibrary.uploadHint")}</div>
                <div className="voice-form__value">
                  {createForm.referenceAudioPath
                    ? displayAudioName(createForm.referenceAudioPath)
                    : t("studio.voiceLibrary.noReferenceAudio")}
                </div>
                <div className="voice-form__help">
                  {transcribingCreateAudio
                    ? t("studio.voiceLibrary.transcribing")
                    : createForm.referenceTranscript
                      ? t("studio.voiceLibrary.transcribed")
                      : t("studio.voiceLibrary.transcriptHint")}
                </div>
              </div>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.referenceTranscript")}</span>
                <textarea
                  className="voice-form__textarea"
                  value={createForm.referenceTranscript ?? ""}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, referenceTranscript: event.target.value }))
                  }
                  placeholder={t("studio.voiceLibrary.referenceTranscriptPlaceholder")}
                  rows={4}
                />
              </label>

              {createTranscriptError ? <div className="voice-form__error">{createTranscriptError}</div> : null}
              {createError ? <div className="voice-form__error">{createError}</div> : null}
            </div>

            <div className="voice-modal__footer">
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => {
                  setCreateTranscriptError(null);
                  setCreateOpen(false);
                }}
              >
                {t("studio.voiceLibrary.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => void handleCreateVoice()}
                disabled={creating || transcribingCreateAudio}
              >
                {t("studio.voiceLibrary.create")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detailVoice ? (
        <div className="voice-modal__overlay" onClick={() => setDetailVoiceId(null)}>
          <div className="voice-modal" onClick={(event) => event.stopPropagation()}>
            <div className="voice-modal__header">
              <h3 className="voice-modal__title">{t("studio.voiceLibrary.detailTitle")}</h3>
              <button
                type="button"
                className="voice-modal__close"
                onClick={() => setDetailVoiceId(null)}
                aria-label={t("studio.voiceLibrary.close")}
              >
                ×
              </button>
            </div>

            <div className="voice-modal__body">
              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.name")}</span>
                <input
                  className="voice-form__input"
                  value={detailForm.name}
                  onChange={(event) => setDetailForm((current) => ({ ...current, name: event.target.value }))}
                  disabled={!detailVoice.canRename}
                />
              </label>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.language")}</span>
                <input
                  className="voice-form__input"
                  value={detailForm.language}
                  onChange={(event) => setDetailForm((current) => ({ ...current, language: event.target.value }))}
                  disabled={!detailVoice.canRename}
                />
              </label>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.description")}</span>
                <textarea
                  className="voice-form__textarea"
                  value={detailForm.description}
                  onChange={(event) => setDetailForm((current) => ({ ...current, description: event.target.value }))}
                  rows={5}
                  disabled={!detailVoice.canRename}
                />
              </label>

              <div className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.referenceAudio")}</span>
                <div className="voice-form__value">
                  {detailVoice.referenceAudioPath
                    ? displayAudioName(detailVoice.referenceAudioPath)
                    : t("studio.voiceLibrary.textOnly")}
                </div>
              </div>

              <label className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.referenceTranscript")}</span>
                <textarea
                  className="voice-form__textarea"
                  value={detailForm.referenceTranscript}
                  onChange={(event) =>
                    setDetailForm((current) => ({ ...current, referenceTranscript: event.target.value }))
                  }
                  rows={4}
                  disabled={!detailVoice.canRename}
                />
              </label>

              <div className="voice-form__field">
                <span className="voice-form__label">{t("studio.voiceLibrary.typeLabel")}</span>
                <div className="voice-form__value">
                  {detailVoice.sourceType === "builtin"
                    ? t("studio.voiceLibrary.builtin")
                    : t("studio.voiceLibrary.custom")}
                </div>
              </div>

              {detailError ? <div className="voice-form__error">{detailError}</div> : null}
            </div>

            <div className="voice-modal__footer">
              {detailVoice.canDelete ? (
                <button
                  type="button"
                  className="voice-action voice-action--danger"
                  onClick={() => void handleDeleteVoice()}
                  disabled={deletingDetail}
                >
                  {t("studio.voiceLibrary.delete")}
                </button>
              ) : (
                <span className="voice-modal__readonly">{t("studio.voiceLibrary.readonly")}</span>
              )}

              <div className="voice-modal__footer-spacer" />

              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => setDetailVoiceId(null)}
              >
                {t("studio.voiceLibrary.close")}
              </button>
              {detailVoice.canRename ? (
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  onClick={() => void handleSaveVoice()}
                  disabled={savingDetail}
                >
                  {t("studio.voiceLibrary.save")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
