import { useState } from "react";
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

const PLACEHOLDER = "—";

function renderBytes(storageInfo: StorageInfo | null, accessor: (s: StorageInfo) => number) {
  if (!storageInfo) return PLACEHOLDER;
  return formatBytes(accessor(storageInfo));
}

type StorageModalProps = {
  /**
   * Lazy storage usage snapshot. ``null`` means the parent has just
   * triggered ``getStorageInfo()`` and the data hasn't arrived yet — we
   * render placeholder rows in that window so the modal still appears
   * instantly.
   */
  storageInfo: StorageInfo | null;
  cacheBytes: number;
  closing?: boolean;
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
  cacheBytes,
  closing = false,
  onCacheCleared,
  onClose,
}: StorageModalProps) {
  const { t } = useTranslation();
  const [localCacheBytes, setLocalCacheBytes] = useState(cacheBytes);
  const [clearingCache, setClearingCache] = useState(false);

  const handleClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    try {
      const result = await clearCache();
      if (result?.success) {
        const nextStorageInfo = result.storageInfo ?? null;
        const remaining =
          nextStorageInfo?.cacheBytes ?? result.remainingBytes ?? 0;
        setLocalCacheBytes(remaining);
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

  const storageItems = [
    {
      label: t("settings.logs.modelSize"),
      value: renderBytes(storageInfo, (s) => s.modelBytes),
    },
    {
      label: t("settings.logs.voiceLibrary"),
      value: renderBytes(storageInfo, (s) => s.voiceLibraryBytes),
    },
    {
      label: t("settings.logs.downloadCache"),
      value: renderBytes(storageInfo, (s) => s.downloadCacheBytes),
    },
    {
      label: t("settings.logs.logSize"),
      value: renderBytes(storageInfo, (s) => s.logBytes),
    },
  ];

  const summaryValue = storageInfo
    ? formatBytes(storageInfo.managedStorageBytes)
    : PLACEHOLDER;
  const cacheRowValue = storageInfo ? formatBytes(localCacheBytes) : PLACEHOLDER;

  return (
    <div className={`storage-modal-overlay${closing ? " modal-closing-overlay" : ""}`} onClick={onClose}>
      <div className={`storage-modal${closing ? " modal-closing-content" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="storage-modal__header">
          <h2 className="storage-modal__title">{t("settings.logs.storageOverview")}</h2>
          <button className="storage-modal__close" onClick={onClose} type="button">
            &times;
          </button>
        </div>

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
