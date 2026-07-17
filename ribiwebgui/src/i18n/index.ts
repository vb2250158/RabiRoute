import { computed, readonly, ref } from "vue";
import { englishCatalog, englishPatterns } from "./catalog";

export type AppLocale = "zh-CN" | "en";

export const LOCALE_STORAGE_KEY = "rabiroute:webgui:locale";
export const LOCALE_CHANGED_EVENT = "rabiroute:locale-changed";

function browserLocale(): AppLocale {
  if (typeof window === "undefined") return "zh-CN";
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "en" || stored === "zh-CN") return stored;
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
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
  if (activeLocale.value === locale) {
    announceLocale(locale);
    return;
  }
  activeLocale.value = locale;
  persistLocale(locale);
  announceLocale(locale);
}

export function translateText(source: string, locale: AppLocale = activeLocale.value): string {
  if (locale === "zh-CN" || !source) return source;
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  const text = source.slice(leading.length, source.length - trailing.length || undefined);
  const exact = englishCatalog[text];
  if (exact) return `${leading}${exact}${trailing}`;
  for (const [pattern, replacer] of englishPatterns) {
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
