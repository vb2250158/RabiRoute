import type { DesktopTheme } from "@shared/desktopSettingsContract";
import type { WebThemeCatalog, WebThemeId, WebThemeResourceId } from "./pluginThemes";
import { resolveWebThemeResource } from "./pluginThemes";

export type EffectiveInterfaceTheme = "light" | "dark";

export const INTERFACE_THEME_CHANGED = "rabiroute:interface-theme-changed";

export function resolveInterfaceTheme(theme: DesktopTheme, systemDark: boolean): EffectiveInterfaceTheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function applyInterfaceTheme(
  theme: DesktopTheme,
  systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches,
  webResourceId?: WebThemeResourceId
): EffectiveInterfaceTheme {
  const resolved = resolveInterfaceTheme(theme, systemDark);
  document.documentElement.dataset.rabirouteTheme = resolved;
  if (webResourceId) document.documentElement.dataset.rabirouteThemeResource = webResourceId;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function applyCatalogInterfaceTheme(
  catalog: WebThemeCatalog,
  preference: WebThemeId,
  systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches
): EffectiveInterfaceTheme {
  const selected = resolveWebThemeResource(catalog, preference);
  const resolved = selected.apply(systemDark);
  document.documentElement.dataset.rabirouteTheme = resolved;
  document.documentElement.dataset.rabirouteThemeResource = selected.webResourceId;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function publishInterfaceTheme(theme: WebThemeId): void {
  window.dispatchEvent(new CustomEvent<WebThemeId>(INTERFACE_THEME_CHANGED, { detail: theme }));
}
