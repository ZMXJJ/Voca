import { useState } from "react";
import type { ServiceInfo } from "@voca/contracts";
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
  serviceInfo: ServiceInfo | null;
  cacheBytes: number;
  closing?: boolean;
  onCacheCleared: (
    serviceInfo: ServiceInfo | null,
    removedTaskIds: string[],
    remainingBytes: number,
    clearedAudioDirs: string[],
  ) => void;
  onClose: () => void;
};

export function StorageModal({
  serviceInfo,
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
        const remaining = result.serviceInfo?.cacheBytes ?? result.remainingBytes ?? 0;
        setLocalCacheBytes(remaining);
          onCacheCleared(
            result.serviceInfo ?? null,
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
    { label: t("settings.logs.modelSize"), value: formatBytes(serviceInfo?.modelBytes) },
    { label: t("settings.logs.voiceLibrary"), value: formatBytes(serviceInfo?.voiceLibraryBytes) },
    { label: t("settings.logs.downloadCache"), value: formatBytes(serviceInfo?.downloadCacheBytes) },
    { label: t("settings.logs.logSize"), value: formatBytes(serviceInfo?.logBytes) },
  ];

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
          <span className="storage-modal__summary-value">{formatBytes(serviceInfo?.managedStorageBytes)}</span>
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
              <span className="storage-modal__row-value">{formatBytes(localCacheBytes)}</span>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => void handleClearCache()}
                disabled={clearingCache}
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
