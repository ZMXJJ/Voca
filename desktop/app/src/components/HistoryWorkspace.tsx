import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GenerationParams, VoiceEntry, WorkEntry, WorkVoiceFacet } from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { deleteWork, listWorkFacets, listWorks, updateWork } from "../lib/tauri";
import { AudioPlayer } from "./AudioPlayer";
import { getAudioDownloadPath } from "../lib/audioDownloadPath";
import { CustomSelect } from "./CustomSelect";
import { IconMicrophone, IconPlay } from "./Icons";

type HistoryWorkspaceProps = {
  /**
   * First page of works owned by App — used only as a refetch trigger: when
   * the parent list changes (a generation finished, cache cleared), this
   * page re-pulls its own filtered view.
   */
  works: WorkEntry[];
  voices: VoiceEntry[];
  onWorksChanged: () => Promise<void>;
  onReuseParams: (params: GenerationParams) => void;
};

const PAGE_SIZE = 30;
const ALL_VOICES = "__all__";

function formatWorkTime(value: string, language: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(ms?: number | null) {
  if (!ms) return "0:00";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function workToGenerationParams(work: WorkEntry): GenerationParams {
  if (work.mode === "legacy_import") {
    // Imported rows only recorded text + voice; everything else is unknown
    // and must stay at the composer defaults.
    return {
      mode: "voice_design",
      targetText: work.targetText,
      voiceName: work.voiceName ?? undefined,
    };
  }
  return {
    mode: work.mode as GenerationParams["mode"],
    targetText: work.targetText,
    modelKey: work.modelKey ?? undefined,
    voiceId: work.voiceId ?? undefined,
    voiceName: work.voiceName ?? undefined,
    cfgValue: work.cfgValue ?? undefined,
    inferenceTimesteps: work.inferenceTimesteps ?? undefined,
    seed: work.seed ?? undefined,
    normalize: work.normalize ?? undefined,
    denoise: work.denoise ?? undefined,
    extremeClone: work.extremeClone ?? undefined,
  };
}

export function HistoryWorkspace({ works, onWorksChanged, onReuseParams }: HistoryWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;

  const [items, setItems] = useState<WorkEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [voiceFilter, setVoiceFilter] = useState<string>(ALL_VOICES);
  const [facets, setFacets] = useState<WorkVoiceFacet[]>([]);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [playNonce, setPlayNonce] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Debounce the search box into the effective query.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const facetById = useMemo(() => {
    const map = new Map<string, WorkVoiceFacet>();
    for (const facet of facets) {
      map.set(facet.voiceId ?? `name:${facet.voiceName ?? ""}`, facet);
    }
    return map;
  }, [facets]);

  const buildQuery = useCallback(
    (offset: number) => {
      const facet = voiceFilter === ALL_VOICES ? null : facetById.get(voiceFilter);
      return {
        limit: PAGE_SIZE,
        offset,
        search: search || undefined,
        voiceId: facet?.voiceId ?? undefined,
        voiceName: facet?.voiceId ? undefined : (facet?.voiceName ?? undefined),
      };
    },
    [facetById, search, voiceFilter],
  );

  const refreshFacets = useCallback(async () => {
    setFacets(await listWorkFacets());
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listWorks(buildQuery(0));
      setItems(response.items);
      setTotal(response.total);
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    void refreshFacets();
  }, [refreshFacets]);

  // Refetch when the parent's works list changes identity (new generation
  // finished, cache cleared elsewhere) so live inserts appear on this page.
  const worksRef = useRef(works);
  useEffect(() => {
    if (worksRef.current !== works) {
      worksRef.current = works;
      void loadFirstPage();
      void refreshFacets();
    }
  }, [loadFirstPage, refreshFacets, works]);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await listWorks(buildQuery(items.length));
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(response.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const selectedWork = useMemo(
    () => items.find((item) => item.id === selectedWorkId) ?? null,
    [items, selectedWorkId],
  );

  const handleStartRename = (work: WorkEntry) => {
    setRenamingId(work.id);
    setRenameDraft(work.title);
    setPendingDeleteId(null);
    window.setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const handleRenameCommit = async (workId: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    const current = items.find((item) => item.id === workId);
    if (!current || current.title === title) return;
    try {
      const updated = await updateWork(workId, { title });
      setItems((list) => list.map((item) => (item.id === workId ? updated : item)));
      void onWorksChanged();
    } catch {
      setActionError(t("history.renameFailed"));
    }
  };

  const handleDelete = async (workId: string) => {
    setPendingDeleteId(null);
    try {
      await deleteWork(workId);
      setItems((list) => list.filter((item) => item.id !== workId));
      setTotal((current) => Math.max(0, current - 1));
      if (selectedWorkId === workId) {
        setSelectedWorkId(null);
      }
      void onWorksChanged();
      void refreshFacets();
    } catch {
      setActionError(t("history.deleteFailed"));
    }
  };

  useEffect(() => {
    if (!actionError) return;
    const timer = window.setTimeout(() => setActionError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  const voiceOptions = useMemo(
    () => [
      { value: ALL_VOICES, label: t("history.filterAllVoices") },
      ...facets
        .filter((facet) => facet.voiceName || facet.voiceId)
        .map((facet) => ({
          value: facet.voiceId ?? `name:${facet.voiceName ?? ""}`,
          label: `${facet.voiceName ?? t("history.unknownVoice")} (${facet.count})`,
        })),
    ],
    [facets, t],
  );

  const isFiltered = Boolean(search) || voiceFilter !== ALL_VOICES;
  const downloadFileName = useMemo(() => {
    if (!selectedWork) return undefined;
    const parts = [selectedWork.voiceName?.trim(), selectedWork.title.slice(0, 10).trim()].filter(Boolean);
    return parts.length > 0 ? `${parts.join("_")}.wav` : undefined;
  }, [selectedWork]);

  return (
    <>
      <h1 className="settings-title">{t("history.title")}</h1>

      <div className="works-toolbar">
        <input
          className="works-toolbar__search"
          type="text"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t("history.searchPlaceholder")}
        />
        <CustomSelect
          className="works-toolbar__voice-filter"
          value={voiceFilter}
          onChange={setVoiceFilter}
          options={voiceOptions}
          icon={<IconMicrophone size={14} />}
        />
        <span className="works-toolbar__count">{t("history.count", { count: total })}</span>
      </div>

      <div className="works-list-area">
          {items.length === 0 ? (
            <p className="works-empty">
              {loading ? "" : isFiltered ? t("history.emptyFiltered") : t("history.empty")}
            </p>
          ) : (
            <div className="history-list">
              {items.map((work) => {
                const isSelected = selectedWorkId === work.id;
                const isRenaming = renamingId === work.id;
                const isPendingDelete = pendingDeleteId === work.id;
                const metaParts = [
                  formatWorkTime(work.createdAt, language),
                  formatDuration(work.durationMs),
                  work.voiceName?.trim() || null,
                  work.mode === "legacy_import" ? t("history.meta.legacyImport") : null,
                ].filter(Boolean);

                return (
                  <div
                    key={work.id}
                    className={`history-item${isSelected ? " history-item--selected" : ""}`}
                    onClick={() => {
                      if (isRenaming) return;
                      setSelectedWorkId(work.id);
                      setPlayNonce((value) => value + 1);
                    }}
                  >
                    <button
                      className="history-item__play"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedWorkId(work.id);
                        setPlayNonce((value) => value + 1);
                      }}
                      aria-label={`Play ${work.title}`}
                    >
                      <IconPlay size={12} />
                    </button>
                    <div className="history-item__content">
                      <div className="history-item__info">
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            className="history-item__rename-input"
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void handleRenameCommit(work.id);
                              if (event.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={() => void handleRenameCommit(work.id)}
                            maxLength={80}
                          />
                        ) : (
                          <div className="history-item__text" title={work.targetText}>
                            {work.title || t("history.untitled")}
                          </div>
                        )}
                        <div className="history-item__meta">{metaParts.join(" · ")}</div>
                      </div>
                      <div
                        className="history-item__actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {isPendingDelete ? (
                          <>
                            <button
                              className="works-action works-action--danger"
                              type="button"
                              onClick={() => void handleDelete(work.id)}
                            >
                              {t("history.actions.deleteConfirm")}
                            </button>
                            <button
                              className="works-action"
                              type="button"
                              onClick={() => setPendingDeleteId(null)}
                            >
                              {t("history.actions.deleteCancel")}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="works-action"
                              type="button"
                              onClick={() => onReuseParams(workToGenerationParams(work))}
                              title={t("history.actions.reuseHint")}
                            >
                              {t("history.actions.reuse")}
                            </button>
                            <button
                              className="works-action"
                              type="button"
                              onClick={() => handleStartRename(work)}
                            >
                              {t("history.actions.rename")}
                            </button>
                            <button
                              className="works-action works-action--danger"
                              type="button"
                              onClick={() => {
                                setPendingDeleteId(work.id);
                                setRenamingId(null);
                              }}
                            >
                              {t("history.actions.delete")}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {items.length < total ? (
            <div className="works-load-more">
              <button
                className="btn btn--secondary btn--small"
                type="button"
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
              >
                {loadingMore ? t("history.loadingMore") : t("history.loadMore")}
              </button>
            </div>
          ) : null}
      </div>

      {selectedWork && (
        <AudioPlayer
          audioPath={selectedWork.audioPath}
          autoPlay={Boolean(selectedWorkId)}
          playNonce={playNonce}
          downloadName={downloadFileName}
          defaultDirectory={getAudioDownloadPath()}
        />
      )}

      {actionError && (
        <div className="error-toast" onClick={() => setActionError(null)}>
          <span className="error-toast__detail">{actionError}</span>
        </div>
      )}
    </>
  );
}
