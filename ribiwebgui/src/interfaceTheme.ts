import type { DesktopTheme } from "@shared/desktopSettingsContract";
import { readableInterfaceThemeForeground, type CustomInterfaceTheme } from "@shared/interfaceThemeContract";
import type { WebThemeCatalog, WebThemeId, WebThemeResourceId } from "./pluginThemes";
import { resolveWebThemeResource } from "./pluginThemes";

export type EffectiveInterfaceTheme = "light" | "dark";

export const INTERFACE_THEME_CHANGED = "rabiroute:interface-theme-changed";

const CUSTOM_THEME_PROPERTIES = [
  "--rr-page-canvas", "--rr-canvas", "--rr-surface", "--rr-subtle", "--rr-input",
  "--rr-border", "--rr-border-strong", "--rr-text", "--rr-heading", "--rr-muted",
  "--rr-muted-soft", "--rr-muted-faint", "--rr-disabled", "--rr-accent", "--rr-accent-strong",
  "--rr-accent-surface", "--rr-accent-border", "--rr-success-surface", "--rr-success-border",
  "--rr-warning-surface", "--rr-warning-border", "--rr-error-surface", "--rr-error-border",
  "--rr-info-surface", "--rr-info-border", "--rr-border-soft", "--rr-border-faint",
  "--rr-grid-line", "--rr-grid-line-soft", "--rr-surface-glass", "--rr-surface-chrome",
  "--rr-surface-sidebar", "--rr-surface-route", "--rr-shadow-card", "--rr-shadow-menu",
  "--rr-switch-track", "--rr-switch-track-active", "--rr-switch-thumb", "--rr-switch-thumb-active",
  "--rr-switch-track-shadow", "--rr-switch-thumb-shadow", "--rr-warning-text", "--rr-card-radius"
] as const;

function hexToRgba(hex: string, opacity: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

function clearCustomInterfaceTheme(): void {
  for (const property of CUSTOM_THEME_PROPERTIES) document.documentElement.style.removeProperty(property);
}

function applyCustomInterfaceTheme(theme: CustomInterfaceTheme): void {
  clearCustomInterfaceTheme();
  const root = document.documentElement.style;
  const { colors, styles } = theme;
  const direct: Record<string, string> = {
    "--rr-page-canvas": colors.pageCanvas,
    "--rr-canvas": colors.canvas,
    "--rr-surface": colors.surface,
    "--rr-subtle": colors.subtle,
    "--rr-input": colors.input,
    "--rr-border": colors.border,
    "--rr-border-strong": colors.borderStrong,
    "--rr-text": colors.text,
    "--rr-heading": colors.heading,
    "--rr-muted": colors.muted,
    "--rr-muted-soft": colors.muted,
    "--rr-muted-faint": colors.muted,
    "--rr-disabled": colors.borderStrong,
    "--rr-accent": colors.accent,
    "--rr-accent-strong": colors.accentStrong,
    "--rr-accent-surface": `color-mix(in srgb, ${colors.accent} 12%, ${colors.surface})`,
    "--rr-accent-border": `color-mix(in srgb, ${colors.accent} 38%, ${colors.border})`,
    "--rr-success-surface": `color-mix(in srgb, ${colors.success} 14%, ${colors.surface})`,
    "--rr-success-border": `color-mix(in srgb, ${colors.success} 42%, ${colors.border})`,
    "--rr-warning-surface": `color-mix(in srgb, ${colors.warning} 14%, ${colors.surface})`,
    "--rr-warning-border": `color-mix(in srgb, ${colors.warning} 42%, ${colors.border})`,
    "--rr-error-surface": `color-mix(in srgb, ${colors.error} 14%, ${colors.surface})`,
    "--rr-error-border": `color-mix(in srgb, ${colors.error} 42%, ${colors.border})`,
    "--rr-info-surface": `color-mix(in srgb, ${colors.info} 14%, ${colors.surface})`,
    "--rr-info-border": `color-mix(in srgb, ${colors.info} 42%, ${colors.border})`,
    "--rr-border-soft": hexToRgba(colors.text, .14),
    "--rr-border-faint": hexToRgba(colors.text, .09),
    "--rr-grid-line": hexToRgba(colors.accentStrong, .05),
    "--rr-grid-line-soft": hexToRgba(colors.accentStrong, .035),
    "--rr-surface-glass": hexToRgba(colors.surface, styles.glassOpacity / 100),
    "--rr-surface-chrome": hexToRgba(colors.surface, Math.min(1, (styles.glassOpacity + 3) / 100)),
    "--rr-surface-sidebar": `linear-gradient(180deg, ${hexToRgba(colors.surface, Math.min(1, (styles.glassOpacity + 4) / 100))}, ${hexToRgba(colors.canvas, styles.glassOpacity / 100)})`,
    "--rr-surface-route": `linear-gradient(135deg, ${hexToRgba(colors.subtle, styles.glassOpacity / 100)}, ${hexToRgba(colors.surface, styles.glassOpacity / 100)})`,
    "--rr-shadow-card": styles.shadow === "none" ? "none" : styles.shadow === "strong" ? `0 14px 30px ${hexToRgba(colors.text, .24)}` : `0 10px 24px ${hexToRgba(colors.text, .1)}`,
    "--rr-shadow-menu": styles.shadow === "none" ? "none" : styles.shadow === "strong" ? `0 20px 50px ${hexToRgba(colors.text, .34)}` : `0 18px 45px ${hexToRgba(colors.text, .18)}`,
    "--rr-switch-track": colors.switchTrack,
    "--rr-switch-track-active": colors.success,
    "--rr-switch-thumb": colors.switchThumb,
    "--rr-switch-thumb-active": colors.switchThumb,
    "--rr-switch-track-shadow": `inset 0 1px 2px ${hexToRgba(colors.text, .18)}`,
    "--rr-switch-thumb-shadow": `0 8px 18px ${hexToRgba(colors.text, .24)}`,
    "--rr-warning-text": colors.warning,
    "--rr-card-radius": `${styles.cornerRadius}px`
  };
  for (const [property, value] of Object.entries(direct)) root.setProperty(property, value);
}

export function customVuetifyTheme(theme: CustomInterfaceTheme) {
  const { colors } = theme;
  return {
    dark: theme.baseTheme === "dark",
    variables: {},
    colors: {
      background: colors.canvas,
      surface: colors.surface,
      primary: colors.heading,
      secondary: colors.accent,
      accent: colors.accentStrong,
      success: colors.success,
      warning: colors.warning,
      error: colors.error,
      info: colors.info,
      "on-background": colors.text,
      "on-surface": colors.text,
      "on-primary": readableInterfaceThemeForeground(colors.heading),
      "on-secondary": readableInterfaceThemeForeground(colors.accent),
      "on-accent": readableInterfaceThemeForeground(colors.accentStrong),
      "on-success": readableInterfaceThemeForeground(colors.success),
      "on-warning": readableInterfaceThemeForeground(colors.warning),
      "on-error": readableInterfaceThemeForeground(colors.error),
      "on-info": readableInterfaceThemeForeground(colors.info)
    }
  };
}

export function resolveInterfaceTheme(theme: DesktopTheme, systemDark: boolean): EffectiveInterfaceTheme {
  if (theme === "light" || theme === "dark") return theme;
  return systemDark ? "dark" : "light";
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
  if (selected.customTheme) applyCustomInterfaceTheme(selected.customTheme);
  else clearCustomInterfaceTheme();
  document.documentElement.dataset.rabirouteTheme = resolved;
  document.documentElement.dataset.rabirouteThemeResource = selected.webResourceId;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function publishInterfaceTheme(theme: WebThemeId): void {
  window.dispatchEvent(new CustomEvent<WebThemeId>(INTERFACE_THEME_CHANGED, { detail: theme }));
}
