import { computed, readonly, ref } from "vue";
import { englishCatalog, englishPatterns } from "./catalog";
import { japaneseCatalog, japanesePatterns } from "./japanese";

export type AppLocale = "zh-CN" | "en" | "ja";

export const localeOptions = [
  { locale: "zh-CN", label: "简体中文", detail: "Chinese", short: "中", ariaLabel: "语言：简体中文" },
  { locale: "en", label: "English", detail: "English", short: "EN", ariaLabel: "Language: English" },
  { locale: "ja", label: "日本語", detail: "Japanese", short: "日", ariaLabel: "言語：日本語" }
] as const;

export function resolveLocale(stored: string | null, language: string): AppLocale {
  if (localeOptions.some(option => option.locale === stored)) return stored as AppLocale;
  const normalized = language.toLowerCase();
  if (normalized.startsWith("ja")) return "ja";
  return normalized.startsWith("zh") ? "zh-CN" : "en";
}

export const LOCALE_STORAGE_KEY = "rabiroute:webgui:locale";
export const LOCALE_CHANGED_EVENT = "rabiroute:locale-changed";

function browserLocale(): AppLocale {
  if (typeof window === "undefined") return "zh-CN";
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(LOCALE_STORAGE_KEY); } catch {
    // Browser language remains usable when storage is disabled.
  }
  return resolveLocale(stored, window.navigator.language);
}

const activeLocale = ref<AppLocale>(browserLocale());

function persistLocale(locale: AppLocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Language remains available for this session when local storage is disabled.
  }
}

function announceLocale(locale: AppLocale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AppLocale>(LOCALE_CHANGED_EVENT, { detail: locale }));
  }
}

export function setLocale(locale: AppLocale): void {
  activeLocale.value = locale;
  persistLocale(locale);
  announceLocale(locale);
}

export function translateText(source: string, locale: AppLocale = activeLocale.value): string {
  if (locale === "zh-CN" || !source) return source;
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  const text = source.slice(leading.length, source.length - trailing.length || undefined);
  const catalog = locale === "ja" ? japaneseCatalog : englishCatalog;
  const patterns = locale === "ja" ? japanesePatterns : englishPatterns;
  const exact = catalog[text];
  if (exact) return `${leading}${exact}${trailing}`;
  for (const [pattern, replacer] of patterns) {
    const match = text.match(pattern);
    if (match) return `${leading}${replacer(...match)}${trailing}`;
  }
  return source;
}

export function useI18n() {
  return {
    locale: readonly(activeLocale),
    isEnglish: computed(() => activeLocale.value === "en"),
    setLocale,
    t: translateText
  };
}

announceLocale(activeLocale.value);
