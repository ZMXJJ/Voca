import { useTranslation } from "react-i18next";
import { openExternalUrl, type UpdateCheckResult } from "../lib/tauri";

type UpdateAvailableModalProps = {
  result: UpdateCheckResult;
  closing?: boolean;
  onClose: () => void;
};

export function UpdateAvailableModal({
  result,
  closing = false,
  onClose,
}: UpdateAvailableModalProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`storage-modal-overlay${closing ? " modal-closing-overlay" : ""}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`storage-modal${closing ? " modal-closing-content" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="storage-modal__header">
          <h2 className="storage-modal__title">
            {t("settings.general.updateAvailable", { version: result.latestVersion })}
          </h2>
          <button
            className="storage-modal__close"
            onClick={onClose}
            type="button"
            aria-label={t("settings.general.updateDismiss")}
          >
            &times;
          </button>
        </div>

        <div className="storage-modal__summary">
          <span className="storage-modal__summary-label">
            {t("settings.general.updateCompareHint", {
              current: result.currentVersion,
              latest: result.latestVersion,
            })}
          </span>
        </div>

        {result.releaseNotes ? (
          <div className="update-modal__notes">
            <pre className="update-modal__notes-content">{result.releaseNotes}</pre>
          </div>
        ) : null}

        <div className="storage-modal__footer">
          <button
            className="btn btn--secondary"
            style={{ flex: 1 }}
            type="button"
            onClick={onClose}
          >
            {t("settings.general.updateDismiss")}
          </button>
          <button
            className="btn btn--primary"
            style={{ flex: 1 }}
            type="button"
            onClick={() => void openExternalUrl(result.releaseUrl)}
          >
            {t("settings.general.updateGoToDownload")}
          </button>
        </div>
      </div>
    </div>
  );
}
