import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";

export const LANGUAGE_STORAGE_KEY = "voca.locale";
export const SUPPORTED_LANGUAGES = ["en", "zh-CN", "zh-TW"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function resolveAppLanguage(language?: string | null): SupportedLanguage {
  if (!language) {
    return "en";
  }

  const lowered = language.trim().toLowerCase().replace(/_/g, "-");

  if (lowered.startsWith("zh")) {
    if (
      lowered.includes("hant") ||
      lowered === "zh-tw" ||
      lowered.startsWith("zh-tw-") ||
      lowered === "zh-hk" ||
      lowered.startsWith("zh-hk-") ||
      lowered === "zh-mo" ||
      lowered.startsWith("zh-mo-")
    ) {
      return "zh-TW";
    }

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
      return resolveAppLanguage(stored);
    }

    return resolveAppLanguage(window.navigator.language);
  }

  return "en";
}

export function setAppLanguage(language: SupportedLanguage) {
  const nextLanguage = resolveAppLanguage(language);

  if (typeof window !== "undefined") {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
  }

  return i18n.changeLanguage(nextLanguage);
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
    "zh-TW": {
      translation: zhTW,
    },
  },
});

export default i18n;
