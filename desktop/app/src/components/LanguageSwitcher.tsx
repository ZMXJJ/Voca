import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGE_SHORT_LABELS,
  resolveAppLanguage,
  setAppLanguage,
  SUPPORTED_LANGUAGES,
} from "../i18n";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const currentLanguage = resolveAppLanguage(i18n.resolvedLanguage);
  const currentIndex = SUPPORTED_LANGUAGES.indexOf(currentLanguage);

  return (
    <div
      className="language-switcher"
      data-active={currentLanguage}
      aria-label={t("common.language.label")}
      style={
        {
          "--language-switcher-count": SUPPORTED_LANGUAGES.length,
          "--language-switcher-index": currentIndex,
        } as CSSProperties
      }
    >
      <span className="language-switcher__thumb" aria-hidden />
      {SUPPORTED_LANGUAGES.map((language) => (
        <button
          key={language}
          className={`language-switcher__option ${
            currentLanguage === language ? "language-switcher__option--active" : ""
          }`}
          onClick={() => {
            void setAppLanguage(language);
          }}
          type="button"
        >
          {LANGUAGE_SHORT_LABELS[language]}
        </button>
      ))}
    </div>
  );
}
