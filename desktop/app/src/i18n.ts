import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export const LANGUAGE_STORAGE_KEY = "voca.locale";
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

function normalizeLanguage(language?: string | null): SupportedLanguage {
  if (!language) {
    return "en";
  }

  const lowered = language.toLowerCase();

  if (lowered.startsWith("zh")) {
    return "zh-CN";
  }

  if (lowered.startsWith("en")) {
    return "en";
  }

  return "en";
}

function getInitialLanguage(): SupportedLanguage {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

    if (stored) {
      return normalizeLanguage(stored);
    }

    return normalizeLanguage(window.navigator.language);
  }

  return "en";
}

export function setAppLanguage(language: SupportedLanguage) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }

  return i18n.changeLanguage(language);
}

void i18n.use(initReactI18next).init({
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
  resources: {
    en: {
      translation: en,
    },
    "zh-CN": {
      translation: zhCN,
    },
  },
});

export default i18n;
