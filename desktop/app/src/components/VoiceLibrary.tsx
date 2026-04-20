import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServiceInfo, VoiceCreatePayload, VoiceEntry } from "@voca/contracts";
import {
  TaskQueryError,
  createAsrTask,
  createVoice,
  deleteVoice,
  getServiceInfo,
  getTaskStrict,
  pickAudioFile,
  saveRecordedAudio,
  updateVoice,
} from "../lib/tauri";
import { blobToBase64 } from "../lib/wavEncoder";
import { useModalTransition } from "../lib/useModalTransition";
import { IconPlus, IconUpload } from "./Icons";
import { VoiceRecorderPanel, type VoiceRecorderLabels } from "./VoiceRecorderPanel";

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

function createEmptyVoiceForm(defaultLanguage: string): VoiceCreatePayload {
  return {
    name: "",
    language: defaultLanguage,
    description: "",
    referenceAudioPath: undefined,
    referenceTranscript: "",
    transcriptLanguage: undefined,
  };
}

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

function getServiceInstanceId(serviceInfo: ServiceInfo | null | undefined) {
  return serviceInfo?.instanceId?.trim() || null;
}

function hasServiceRestarted(expectedInstanceId: string | null, serviceInfo: ServiceInfo | null) {
  const currentInstanceId = getServiceInstanceId(serviceInfo);
  return Boolean(expectedInstanceId && currentInstanceId && currentInstanceId !== expectedInstanceId);
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
  const defaultVoiceLanguage = t("studio.voiceLibrary.defaultLanguage");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<VoiceCreatePayload>(() =>
    createEmptyVoiceForm(defaultVoiceLanguage),
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [transcribingCreateAudio, setTranscribingCreateAudio] = useState(false);
  const [createTranscriptError, setCreateTranscriptError] = useState<string | null>(null);
  const [recorderActive, setRecorderActive] = useState(false);
  const [savingRecording, setSavingRecording] = useState(false);
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
  const [detailDeleteConfirm, setDetailDeleteConfirm] = useState(false);

  const createModal = useModalTransition(createOpen);
  const detailModal = useModalTransition(detailVoiceId !== null);

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

  useEffect(() => {
    setDetailDeleteConfirm(false);
  }, [detailVoiceId]);

  const validateVoiceForm = (payload: VoiceCreatePayload) => {
    if (!payload.name.trim()) return t("studio.voiceLibrary.validationName");
    if (!payload.language.trim()) return t("studio.voiceLibrary.validationLanguage");
    if (!payload.description.trim()) return t("studio.voiceLibrary.validationDescription");
    return null;
  };

  const pollTaskUntilFinished = async (taskId: string, expectedInstanceId: string | null) => {
    let missingTaskPolls = 0;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      let task: Awaited<ReturnType<typeof getTaskStrict>>;
      try {
        task = await getTaskStrict(taskId);
      } catch (error) {
        if (error instanceof TaskQueryError) {
          const latestServiceInfo = await getServiceInfo();
          if (hasServiceRestarted(expectedInstanceId, latestServiceInfo)) {
            throw new Error(t("studio.voiceLibrary.transcribeServiceRestarted"));
          }
          if (error.kind === "sidecar_unavailable") {
            throw new Error(t("studio.voiceLibrary.transcribeServiceUnavailable"));
          }
          throw new Error(t("studio.voiceLibrary.transcribeStatusCheckFailed"));
        }
        throw error;
      }
      if (!task) {
        missingTaskPolls += 1;
        if (missingTaskPolls >= 2) {
          const latestServiceInfo = await getServiceInfo();
          if (hasServiceRestarted(expectedInstanceId, latestServiceInfo)) {
            throw new Error(t("studio.voiceLibrary.transcribeServiceRestarted"));
          }
        }
        if (missingTaskPolls >= 6) {
          throw new Error(t("studio.voiceLibrary.transcribeTaskMissing"));
        }
      } else {
        missingTaskPolls = 0;
        if (["succeeded", "failed", "cancelled"].includes(task.status)) {
          return task;
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    throw new Error(t("studio.voiceLibrary.transcribeTimedOut"));
  };

  const runTranscription = async (audioPath: string) => {
    setTranscribingCreateAudio(true);
    try {
      const serviceInfoBeforeTask = await getServiceInfo();
      const task = await createAsrTask({
        audioPath,
        modelKey: "sensevoice_small",
      });
      const serviceInfoAfterTask = await getServiceInfo();
      const expectedInstanceId =
        getServiceInstanceId(serviceInfoAfterTask) ?? getServiceInstanceId(serviceInfoBeforeTask);
      const finishedTask = await pollTaskUntilFinished(task.id, expectedInstanceId);
      if (finishedTask.status !== "succeeded") {
        throw new Error(finishedTask.error?.message || finishedTask.message || "ASR task failed");
      }

      setCreateForm((current) => ({
        ...current,
        referenceAudioPath: audioPath,
        referenceTranscript: finishedTask.result?.transcript ?? "",
        transcriptLanguage: finishedTask.result?.transcriptLanguage ?? "auto",
      }));
    } catch (error) {
      setCreateTranscriptError(formatActionError(t("studio.voiceLibrary.transcribeFailed"), error));
    } finally {
      setTranscribingCreateAudio(false);
    }
  };

  const handlePickReferenceAudio = async () => {
    if (transcribingCreateAudio || creating || recorderActive || savingRecording) return;
    const selectedPath = await pickAudioFile();
    if (!selectedPath) return;
    setCreateTranscriptError(null);
    setCreateError(null);
    setCreateForm((current) => ({
      ...current,
      referenceAudioPath: selectedPath,
      referenceTranscript: "",
      transcriptLanguage: undefined,
    }));
    await runTranscription(selectedPath);
  };

  const handleStartRecording = () => {
    if (
      transcribingCreateAudio ||
      creating ||
      recorderActive ||
      savingRecording ||
      createForm.referenceAudioPath
    ) {
      return;
    }
    setCreateTranscriptError(null);
    setCreateError(null);
    setRecorderActive(true);
  };

  const handleRecorderCancel = () => {
    if (savingRecording) return;
    setRecorderActive(false);
  };

  const handleRecorderUse = async (wavBlob: Blob) => {
    if (savingRecording) return;
    setSavingRecording(true);
    setCreateTranscriptError(null);
    setCreateError(null);
    try {
      const base64 = await blobToBase64(wavBlob);
      const audioPath = await saveRecordedAudio(base64, "wav");
      setCreateForm((current) => ({
        ...current,
        referenceAudioPath: audioPath,
        referenceTranscript: "",
        transcriptLanguage: undefined,
      }));
      setRecorderActive(false);
      await runTranscription(audioPath);
    } catch (error) {
      setCreateTranscriptError(
        formatActionError(t("studio.voiceLibrary.recordingFailed"), error),
      );
    } finally {
      setSavingRecording(false);
    }
  };

  const recorderLabels: VoiceRecorderLabels = {
    recording: t("studio.voiceLibrary.recording"),
    stop: t("studio.voiceLibrary.stopRecording"),
    reRecord: t("studio.voiceLibrary.reRecord"),
    useRecording: t("studio.voiceLibrary.useRecording"),
    cancel: t("studio.voiceLibrary.cancel"),
    saving: t("studio.voiceLibrary.savingRecording"),
    maxHint: t("studio.voiceLibrary.recordMaxHint"),
    permissionDenied: t("studio.voiceLibrary.microphonePermissionDenied"),
    microphoneUnavailable: t("studio.voiceLibrary.microphoneUnavailable"),
    recordingTooShort: t("studio.voiceLibrary.recordingTooShort"),
    recordingFailed: t("studio.voiceLibrary.recordingFailed"),
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
      setCreateForm(createEmptyVoiceForm(defaultVoiceLanguage));
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

  const handleDeleteVoiceConfirmed = async () => {
    if (!detailVoice) return;

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
              setRecorderActive(false);
              setSavingRecording(false);
              setCreateForm(createEmptyVoiceForm(defaultVoiceLanguage));
              setCreateOpen(true);
            }}
          >
            <IconPlus size={12} /> {t("studio.voiceLibrary.upload")}
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

      {createModal.mounted ? (
        <div className={`voice-modal__overlay${createModal.closing ? " modal-closing-overlay" : ""}`}>
          <div className={`voice-modal${createModal.closing ? " modal-closing-content" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="voice-modal__header">
              <h3 className="voice-modal__title">{t("studio.voiceLibrary.uploadTitle")}</h3>
              <button
                type="button"
                className="voice-modal__close"
                onClick={() => {
                  createModal.requestClose(() => {
                    setCreateTranscriptError(null);
                    setRecorderActive(false);
                    setSavingRecording(false);
                    setCreateOpen(false);
                  });
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
                    className="btn btn--ghost btn--small voice-form__record-button"
                    onClick={handleStartRecording}
                    disabled={
                      transcribingCreateAudio ||
                      creating ||
                      recorderActive ||
                      savingRecording ||
                      Boolean(createForm.referenceAudioPath)
                    }
                  >
                    <span className="voice-form__record-dot" aria-hidden="true" />
                    {t("studio.voiceLibrary.recordReferenceAudio")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small voice-form__upload-button"
                    onClick={() => void handlePickReferenceAudio()}
                    disabled={
                      transcribingCreateAudio ||
                      creating ||
                      recorderActive ||
                      savingRecording
                    }
                  >
                    <IconUpload size={12} />
                    {t("studio.voiceLibrary.uploadReferenceAudio")}
                  </button>
                  {recorderActive ? (
                    <VoiceRecorderPanel
                      labels={recorderLabels}
                      saving={savingRecording}
                      onUse={(blob) => void handleRecorderUse(blob)}
                      onCancel={handleRecorderCancel}
                    />
                  ) : createForm.referenceAudioPath ? (
                    <>
                      <span className="voice-form__upload-filename">
                        {displayAudioName(createForm.referenceAudioPath)}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={transcribingCreateAudio || creating || savingRecording}
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
                    </>
                  ) : (
                    <span className="voice-form__upload-placeholder">
                      {t("studio.voiceLibrary.noReferenceAudio")}
                    </span>
                  )}
                </div>
                <div className="voice-form__help">{t("studio.voiceLibrary.uploadHint")}</div>
                {transcribingCreateAudio ? (
                  <div className="voice-form__status" role="status" aria-live="polite">
                    <span className="voice-form__status-spinner" aria-hidden="true" />
                    <div className="voice-form__status-copy">
                      <div className="voice-form__status-title">{t("studio.voiceLibrary.transcribing")}</div>
                      <div className="voice-form__status-text">{t("studio.voiceLibrary.transcribingHint")}</div>
                    </div>
                  </div>
                ) : (
                  <div className="voice-form__help">
                    {createForm.referenceTranscript
                      ? t("studio.voiceLibrary.transcribed")
                      : t("studio.voiceLibrary.transcriptHint")}
                  </div>
                )}
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
                  disabled={transcribingCreateAudio}
                  aria-busy={transcribingCreateAudio}
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
                  setRecorderActive(false);
                  setSavingRecording(false);
                  setCreateOpen(false);
                }}
              >
                {t("studio.voiceLibrary.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => void handleCreateVoice()}
                disabled={creating || transcribingCreateAudio || recorderActive || savingRecording}
              >
                {t("studio.voiceLibrary.create")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detailModal.mounted && detailVoice ? (
        <div className={`voice-modal__overlay${detailModal.closing ? " modal-closing-overlay" : ""}`}>
          <div className={`voice-modal${detailModal.closing ? " modal-closing-content" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="voice-modal__header">
              <h3 className="voice-modal__title">{t("studio.voiceLibrary.detailTitle")}</h3>
              <button
                type="button"
                className="voice-modal__close"
                onClick={() => {
                  detailModal.requestClose(() => {
                    setDetailDeleteConfirm(false);
                    setDetailVoiceId(null);
                  });
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

              {detailVoice.canDelete && detailDeleteConfirm ? (
                <div className="voice-delete-confirm-banner" role="status">
                  {t("studio.voiceLibrary.deleteConfirm", { name: detailVoice.name })}
                </div>
              ) : null}

              {detailError ? <div className="voice-form__error">{detailError}</div> : null}
            </div>

            <div className="voice-modal__footer">
              {detailVoice.canDelete ? (
                detailDeleteConfirm ? (
                  <div className="voice-delete-confirm-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      onClick={() => setDetailDeleteConfirm(false)}
                      disabled={deletingDetail}
                    >
                      {t("studio.voiceLibrary.cancel")}
                    </button>
                    <button
                      type="button"
                      className="voice-action voice-action--danger"
                      onClick={() => void handleDeleteVoiceConfirmed()}
                      disabled={deletingDetail}
                    >
                      {t("studio.voiceLibrary.deleteConfirmAction")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="voice-action voice-action--danger"
                    onClick={() => setDetailDeleteConfirm(true)}
                    disabled={deletingDetail}
                  >
                    {t("studio.voiceLibrary.delete")}
                  </button>
                )
              ) : (
                <span className="voice-modal__readonly">{t("studio.voiceLibrary.readonly")}</span>
              )}

              <div className="voice-modal__footer-spacer" />

              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => {
                  detailModal.requestClose(() => {
                    setDetailDeleteConfirm(false);
                    setDetailVoiceId(null);
                  });
                }}
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
