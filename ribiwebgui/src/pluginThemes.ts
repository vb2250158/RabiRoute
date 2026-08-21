import type { DesktopTheme } from "@shared/desktopSettingsContract";

export type WebThemeResourceId =
  | "builtin.web-theme.system.v1"
  | "builtin.web-theme.light.v1"
  | "builtin.web-theme.dark.v1";

export type WebThemeContribution = Readonly<{
  instanceId: string;
  pluginId: string;
  themeId: DesktopTheme;
  webResourceId: WebThemeResourceId;
}>;

export type WebThemeOption = Readonly<{
  themeId: DesktopTheme;
  webResourceId: WebThemeResourceId;
  label: string;
  icon: string;
}>;

export type WebThemeCatalog = Readonly<{
  themes: readonly WebThemeContribution[];
  options: readonly WebThemeOption[];
}>;

type JsonRecord = Record<string, unknown>;

const builtinWebThemes = {
  system: {
    webResourceId: "builtin.web-theme.system.v1",
    label: "跟随系统",
    icon: "mdi-theme-light-dark"
  },
  light: {
    webResourceId: "builtin.web-theme.light.v1",
    label: "浅色",
    icon: "mdi-weather-sunny"
  },
  dark: {
    webResourceId: "builtin.web-theme.dark.v1",
    label: "深色",
    icon: "mdi-weather-night"
  }
} as const satisfies Record<DesktopTheme, Omit<WebThemeOption, "themeId">>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledSymbol(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized === value && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : "";
}

function isDesktopTheme(value: string): value is DesktopTheme {
  return value === "system" || value === "light" || value === "dark";
}

export function parseWebThemeContribution(value: unknown): WebThemeContribution | undefined {
  if (!isRecord(value) || value.kind !== "theme") return undefined;
  if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) {
    return undefined;
  }
  const instanceId = controlledSymbol(value.instanceId);
  const pluginId = controlledSymbol(value.pluginId);
  const themeId = controlledSymbol(value.themeId);
  const webResourceId = controlledSymbol(value.webResourceId);
  if (!instanceId || !pluginId || !isDesktopTheme(themeId)) return undefined;
  const builtin = builtinWebThemes[themeId];
  if (webResourceId !== builtin.webResourceId) return undefined;
  return { instanceId, pluginId, themeId, webResourceId: builtin.webResourceId };
}

export function resolveWebThemeCatalog(contributions: readonly unknown[] | null): WebThemeCatalog {
  const accepted = (contributions ?? []).flatMap(value => {
    const theme = parseWebThemeContribution(value);
    return theme ? [theme] : [];
  });
  const unique = accepted.filter((theme, index) => (
    accepted.findIndex(candidate => candidate.themeId === theme.themeId) === index
    && accepted.filter(candidate => candidate.themeId === theme.themeId).length === 1
  ));
  return {
    themes: unique,
    options: unique.map(theme => ({ themeId: theme.themeId, ...builtinWebThemes[theme.themeId] }))
  };
}

export function resolveWebThemeResource(
  catalog: WebThemeCatalog,
  preference: DesktopTheme
): Readonly<{ theme: DesktopTheme; webResourceId: WebThemeResourceId }> {
  const selected = catalog.themes.find(theme => theme.themeId === preference);
  if (selected) return { theme: selected.themeId, webResourceId: selected.webResourceId };
  return { theme: "system", webResourceId: builtinWebThemes.system.webResourceId };
}
