import { useCallback, useEffect, useRef, useState } from "react";
import type { StorageInfo } from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { clearCache } from "../lib/tauri";

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

type StorageModalProps = {
  /**
   * Lazy storage usage snapshot. ``null`` means we haven't received a
   * successful response yet — the modal renders a loading placeholder
   * row in that window so the user knows the data is being computed.
   */
  storageInfo: StorageInfo | null;
  closing?: boolean;
  /**
   * Refresh callback owned by the parent. The modal triggers it on every
   * mount so reopening the dialog always shows up-to-date numbers. The
   * promise should reject when the underlying request fails so the modal
   * can render a retry affordance.
   */
  onRefresh: () => Promise<void>;
  onCacheCleared: (
    storageInfo: StorageInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => void;
  onClose: () => void;
};

export function StorageModal({
  storageInfo,
  closing = false,
  onRefresh,
  onCacheCleared,
  onClose,
}: StorageModalProps) {
  const { t } = useTranslation();
  const [clearingCache, setClearingCache] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  // ``cancelledRef`` flips to ``true`` when the modal unmounts so the
  // in-flight refresh (which may still be running on the python sidecar)
  // won't try to mutate state after teardown.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const runRefresh = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    try {
      await onRefresh();
    } catch {
      if (!cancelledRef.current) setErrored(true);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    void runRefresh();
  }, [runRefresh]);

  const handleClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    try {
      const result = await clearCache();
      if (result?.success) {
        const nextStorageInfo = result.storageInfo ?? null;
        const remaining =
          nextStorageInfo?.cacheBytes ?? result.remainingBytes ?? 0;
        onCacheCleared(
          nextStorageInfo,
          result.removedTaskIds ?? [],
          remaining,
          result.clearedAudioDirs ?? [],
        );
      }
    } finally {
      setClearingCache(false);
    }
  };

  const calculatingLabel = t("settings.logs.calculating");

  const renderBytes = (accessor: (s: StorageInfo) => number) => {
    if (storageInfo) return formatBytes(accessor(storageInfo));
    if (loading) return calculatingLabel;
    return "—";
  };

  const summaryValue = storageInfo
    ? formatBytes(storageInfo.managedStorageBytes)
    : loading
      ? calculatingLabel
      : "—";

  const cacheRowValue = renderBytes((s) => s.cacheBytes);

  const storageItems = [
    {
      label: t("settings.logs.modelSize"),
      value: renderBytes((s) => s.modelBytes),
    },
    {
      label: t("settings.logs.voiceLibrary"),
      value: renderBytes((s) => s.voiceLibraryBytes),
    },
    {
      label: t("settings.logs.downloadCache"),
      value: renderBytes((s) => s.downloadCacheBytes),
    },
    {
      label: t("settings.logs.logSize"),
      value: renderBytes((s) => s.logBytes),
    },
  ];

  const showRetryBanner = errored && !loading && !storageInfo;

  return (
    <div className={`storage-modal-overlay${closing ? " modal-closing-overlay" : ""}`} onClick={onClose}>
      <div className={`storage-modal${closing ? " modal-closing-content" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="storage-modal__header">
          <h2 className="storage-modal__title">{t("settings.logs.storageOverview")}</h2>
          <button className="storage-modal__close" onClick={onClose} type="button">
            &times;
          </button>
        </div>

        {showRetryBanner && (
          <button
            className="storage-modal__retry"
            type="button"
            onClick={() => void runRefresh()}
          >
            {t("settings.logs.refreshFailed")}
          </button>
        )}

        <div className="storage-modal__summary">
          <span className="storage-modal__summary-label">{t("settings.logs.managedStorage")}</span>
          <span className="storage-modal__summary-value">{summaryValue}</span>
        </div>

        <div className="storage-modal__list">
          {storageItems.map((item) => (
            <div key={item.label} className="storage-modal__row">
              <span className="storage-modal__row-label">{item.label}</span>
              <span className="storage-modal__row-value">{item.value}</span>
            </div>
          ))}
          <div className="storage-modal__row">
            <span className="storage-modal__row-label">{t("settings.logs.cache")}</span>
            <div className="storage-modal__row-action">
              <span className="storage-modal__row-value">{cacheRowValue}</span>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => void handleClearCache()}
                disabled={clearingCache || !storageInfo}
              >
                {t("settings.logs.clear")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
