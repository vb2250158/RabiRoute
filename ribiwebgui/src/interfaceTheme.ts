import type { DesktopTheme } from "@shared/desktopSettingsContract";
import type { WebThemeCatalog, WebThemeResourceId } from "./pluginThemes";
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
  preference: DesktopTheme,
  systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches
): EffectiveInterfaceTheme {
  const selected = resolveWebThemeResource(catalog, preference);
  return applyInterfaceTheme(selected.theme, systemDark, selected.webResourceId);
}

export function publishInterfaceTheme(theme: DesktopTheme): void {
  window.dispatchEvent(new CustomEvent<DesktopTheme>(INTERFACE_THEME_CHANGED, { detail: theme }));
}
