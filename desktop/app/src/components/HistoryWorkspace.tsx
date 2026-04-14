import { useTranslation } from "react-i18next";

export function HistoryWorkspace() {
  const { t } = useTranslation();

  return (
    <>
      <h1 className="settings-title">{t("history.title")}</h1>
      <div className="coming-soon">
        <div className="coming-soon__title">{t("history.comingSoonTitle")}</div>
        <p className="coming-soon__desc">{t("history.comingSoonDesc")}</p>
      </div>
    </>
  );
}
