import { useTranslation } from "react-i18next";
import { setAppLanguage } from "../i18n";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const currentLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";

  return (
    <div className="language-switcher" aria-label={t("common.language.label")}>
      <button
        className={`language-switcher__option ${
          currentLanguage === "en" ? "language-switcher__option--active" : ""
        }`}
        onClick={() => {
          void setAppLanguage("en");
        }}
      >
        {t("common.language.en")}
      </button>
      <button
        className={`language-switcher__option ${
          currentLanguage === "zh-CN" ? "language-switcher__option--active" : ""
        }`}
        onClick={() => {
          void setAppLanguage("zh-CN");
        }}
      >
        {t("common.language.zhCN")}
      </button>
    </div>
  );
}
