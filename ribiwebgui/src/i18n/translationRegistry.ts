export type PluginTranslationLocale = "en" | "ja";
export type PluginTranslationCatalogs = Readonly<Partial<Record<PluginTranslationLocale, Readonly<Record<string, string>>>>>;

export type WebTranslationModuleApi = Readonly<{
  registerTranslations(catalogs: PluginTranslationCatalogs): () => void;
}>;

type Registration = Readonly<{ pluginId: string; catalogs: PluginTranslationCatalogs }>;

const registrations = new Map<symbol, Registration>();
const listeners = new Set<() => void>();
let catalogs: ReadonlyMap<PluginTranslationLocale, ReadonlyMap<string, string>> = new Map();

function rebuild(): void {
  const next = new Map<PluginTranslationLocale, Map<string, string>>();
  for (const { catalogs: values } of registrations.values()) {
    for (const locale of ["en", "ja"] as const) {
      const entries = values[locale];
      if (!entries) continue;
      let catalog = next.get(locale);
      if (!catalog) { catalog = new Map(); next.set(locale, catalog); }
      for (const [source, translated] of Object.entries(entries)) {
        if (!catalog.has(source)) catalog.set(source, translated);
      }
    }
  }
  catalogs = next;
  for (const listener of listeners) listener();
}

/** Each activation owns one registration; disposing it preserves other active owners. */
export function registerPluginTranslations(pluginId: string, values: PluginTranslationCatalogs): () => void {
  for (const locale of ["en", "ja"] as const) {
    for (const [source, translated] of Object.entries(values[locale] || {})) {
      const previous = catalogs.get(locale)?.get(source);
      if (previous !== undefined && previous !== translated) {
        console.warn(`Translation conflict for ${pluginId}, ${locale}, ${source}; the active owner is retained.`);
      }
    }
  }
  const token = Symbol(pluginId);
  registrations.set(token, { pluginId, catalogs: values });
  rebuild();
  return () => { if (registrations.delete(token)) rebuild(); };
}

export function pluginTranslation(locale: PluginTranslationLocale, source: string): string | undefined {
  return catalogs.get(locale)?.get(source);
}

export function onPluginTranslationsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
