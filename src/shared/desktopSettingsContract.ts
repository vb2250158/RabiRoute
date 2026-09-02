export const DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S";
// Function keys are common game controls. Keep a safer default, while allowing
// an explicit user choice such as F3 to remain usable.
export const DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT = "Ctrl+Alt+V";

import {
  isInterfaceThemeId,
  normalizeCustomInterfaceThemes,
  type CustomInterfaceTheme,
  type InterfaceThemeId
} from "./interfaceThemeContract.js";

export type DesktopScreenshotSettings = {
  enabled: boolean;
  shortcut: string;
  clipboardShortcut: string;
  autoCopy: boolean;
};

export type DesktopTheme = InterfaceThemeId;

export type DesktopPetPlacement = {
  screen: string;
  xRatio: number;
  yRatio: number;
};

export type DesktopPetBinding = {
  enabled: boolean;
  packId: string;
  placement: DesktopPetPlacement | null;
  scale: number;
  opacity: number;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  locked: boolean;
  hideOnFullscreen: boolean;
  bubbleEnabled: boolean;
  fpsCap: 6 | 12 | 15 | 24;
};

export type DesktopSettings = {
  screenshot: DesktopScreenshotSettings;
  autostart: boolean;
  theme: DesktopTheme;
  webTheme: string;
  customThemes: CustomInterfaceTheme[];
  pets: Record<string, DesktopPetBinding>;
};

export const DEFAULT_DESKTOP_PET_BINDING: DesktopPetBinding = {
  enabled: false,
  packId: "",
  placement: null,
  scale: 0.5,
  opacity: 1,
  alwaysOnTop: true,
  clickThrough: false,
  locked: false,
  hideOnFullscreen: true,
  bubbleEnabled: true,
  fpsCap: 15
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  screenshot: {
    enabled: false,
    shortcut: DEFAULT_SCREENSHOT_SHORTCUT,
    clipboardShortcut: DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT,
    autoCopy: true
  },
  autostart: false,
  theme: "system",
  webTheme: "system",
  customThemes: [],
  pets: {}
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function webThemePreference(value: unknown, fallback: DesktopTheme): string {
  const normalized = text(value);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) return fallback;
  return normalized;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function normalizeDesktopPetBinding(value: unknown): DesktopPetBinding {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawPlacement = row.placement && typeof row.placement === "object" && !Array.isArray(row.placement)
    ? row.placement as Record<string, unknown>
    : undefined;
  const placement = rawPlacement && typeof rawPlacement.screen === "string" && rawPlacement.screen.trim()
    ? {
        screen: rawPlacement.screen.trim().slice(0, 200),
        xRatio: boundedNumber(rawPlacement.xRatio, 1, 0, 1),
        yRatio: boundedNumber(rawPlacement.yRatio, 1, 0, 1)
      }
    : null;
  const fps = [6, 12, 15, 24].includes(Number(row.fpsCap)) ? Number(row.fpsCap) as 6 | 12 | 15 | 24 : 15;
  const packId = typeof row.packId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(row.packId.trim())
    ? row.packId.trim()
    : "";
  return {
    enabled: row.enabled === true && Boolean(packId),
    packId,
    placement,
    scale: boundedNumber(row.scale, DEFAULT_DESKTOP_PET_BINDING.scale, 0.1, 2),
    opacity: boundedNumber(row.opacity, DEFAULT_DESKTOP_PET_BINDING.opacity, 0.2, 1),
    alwaysOnTop: row.alwaysOnTop !== false,
    clickThrough: row.clickThrough === true,
    locked: row.locked === true,
    hideOnFullscreen: row.hideOnFullscreen !== false,
    bubbleEnabled: row.bubbleEnabled !== false,
    fpsCap: fps
  };
}

function normalizeDesktopPets(value: unknown): Record<string, DesktopPetBinding> {
  const rows = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(rows)
    .filter(([personaId]) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(personaId))
    .slice(0, 32)
    .map(([personaId, binding]) => [personaId, normalizeDesktopPetBinding(binding)]));
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const screenshot = row.screenshot && typeof row.screenshot === "object" && !Array.isArray(row.screenshot)
    ? row.screenshot as Record<string, unknown>
    : {};
  const customThemes = normalizeCustomInterfaceThemes(row.customThemes);
  const selectedTheme = isInterfaceThemeId(row.theme) ? row.theme : "system";
  const theme = selectedTheme.startsWith("custom:") && !customThemes.some(item => item.id === selectedTheme)
    ? "system"
    : selectedTheme;
  const selectedWebTheme = webThemePreference(row.webTheme, theme);
  const webTheme = selectedWebTheme.startsWith("custom:") && !customThemes.some(item => item.id === selectedWebTheme)
    ? theme
    : selectedWebTheme;
  return {
    screenshot: {
      enabled: screenshot.enabled === true,
      shortcut: text(screenshot.shortcut) || DEFAULT_SCREENSHOT_SHORTCUT,
      clipboardShortcut: text(screenshot.clipboardShortcut) || DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT,
      autoCopy: screenshot.autoCopy !== false
    },
    autostart: row.autostart === true,
    theme,
    webTheme,
    customThemes,
    pets: normalizeDesktopPets(row.pets)
  };
}
