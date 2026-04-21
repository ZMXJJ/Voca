import { useState } from "react";
import { useTranslation } from "react-i18next";

export type LegacyAsrMigrationState = "idle" | "cleaning" | "failed";

type LegacyAsrMigrationModalProps = {
  state: LegacyAsrMigrationState;
  needsRedownload: boolean;
  onConfirm: () => void | Promise<void>;
};

export function LegacyAsrMigrationModal({
  state,
  needsRedownload,
  onConfirm,
}: LegacyAsrMigrationModalProps) {
  const { t } = useTranslation();
  const [hoverConfirm, setHoverConfirm] = useState(false);

  const busy = state === "cleaning";
  const failed = state === "failed";

  const titleKey = needsRedownload
    ? "legacyAsrMigration.title"
    : "legacyAsrMigration.titleCleanupOnly";
  const descriptionKey = needsRedownload
    ? "legacyAsrMigration.description"
    : "legacyAsrMigration.descriptionCleanupOnly";
  const confirmKey = needsRedownload
    ? "legacyAsrMigration.confirm"
    : "legacyAsrMigration.confirmCleanupOnly";
  const busyKey = needsRedownload
    ? "legacyAsrMigration.busy"
    : "legacyAsrMigration.busyCleanupOnly";

  return (
    <div className="storage-modal-overlay" role="dialog" aria-modal="true">
      <div
        className="storage-modal"
        style={{ maxWidth: 520 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="storage-modal__header" style={{ marginBottom: 16 }}>
          <h2 className="storage-modal__title">{t(titleKey)}</h2>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
          }}
        >
          {t(descriptionKey)}
        </p>

        <ul
          style={{
            margin: "16px 0 4px",
            paddingLeft: 18,
            fontSize: 13,
            lineHeight: 1.7,
            color: "var(--text-secondary)",
          }}
        >
          <li>{t("legacyAsrMigration.point1")}</li>
          <li>{t("legacyAsrMigration.point2")}</li>
          {needsRedownload ? <li>{t("legacyAsrMigration.point3")}</li> : null}
        </ul>

        {failed ? (
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 13,
              color: "#ef4444",
            }}
          >
            {t("legacyAsrMigration.failed")}
          </p>
        ) : null}

        <div
          className="storage-modal__footer"
          style={{ justifyContent: "flex-end", marginTop: 24 }}
        >
          <button
            className="btn btn--primary"
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
            onMouseEnter={() => setHoverConfirm(true)}
            onMouseLeave={() => setHoverConfirm(false)}
            style={{
              minWidth: 160,
              opacity: busy && !hoverConfirm ? 0.8 : 1,
            }}
          >
            {busy ? t(busyKey) : failed ? t("common.errorActions.retry") : t(confirmKey)}
          </button>
        </div>
      </div>
    </div>
  );
}
