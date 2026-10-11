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

export type DesktopPetBubbleStyle = {
  skin: "cat-paw" | "plain";
  fontFamily: string;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  borderColor: string;
  maxWidth: number;
  opacity: number;
  displaySeconds: number;
};

export const DEFAULT_DESKTOP_PET_BUBBLE_STYLE: DesktopPetBubbleStyle = {
  skin: "cat-paw", fontFamily: "", fontSize: 14, textColor: "#504650",
  backgroundColor: "#fffaf3", borderColor: "#a58b98", maxWidth: 320,
  opacity: 1, displaySeconds: 8
};

export function normalizeDesktopPetBubbleStyle(value: unknown): DesktopPetBubbleStyle {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const defaults = DEFAULT_DESKTOP_PET_BUBBLE_STYLE;
  const color = (key: "textColor" | "backgroundColor" | "borderColor") =>
    typeof row[key] === "string" && /^#[0-9a-fA-F]{6}$/.test(row[key]) ? row[key].toLowerCase() : defaults[key];
  return {
    skin: row.skin === "plain" ? "plain" : "cat-paw",
    fontFamily: typeof row.fontFamily === "string" ? row.fontFamily.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80) : "",
    fontSize: Math.round(boundedNumber(row.fontSize, defaults.fontSize, 12, 24)),
    textColor: color("textColor"), backgroundColor: color("backgroundColor"), borderColor: color("borderColor"),
    maxWidth: Math.round(boundedNumber(row.maxWidth, defaults.maxWidth, 220, 480)),
    opacity: boundedNumber(row.opacity, defaults.opacity, 0.5, 1),
    displaySeconds: boundedNumber(row.displaySeconds, defaults.displaySeconds, 2, 30)
  };
}

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
  bubbleStyle: DesktopPetBubbleStyle;
  fpsCap: 6 | 12 | 15 | 24;
  wanderEnabled: boolean;
  wanderToActiveWindow: boolean;
  wanderCorners: DesktopPetCorner[];
  wanderWaitMinSeconds: number;
  wanderWaitMaxSeconds: number;
};

export const DESKTOP_PET_CORNERS = [
  { id: "bottom-right", label: "右下角" },
  { id: "bottom-left", label: "左下角" },
  { id: "top-right", label: "右上角" },
  { id: "top-left", label: "左上角" }
] as const;
export type DesktopPetCorner = typeof DESKTOP_PET_CORNERS[number]["id"];

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
  bubbleStyle: { ...DEFAULT_DESKTOP_PET_BUBBLE_STYLE },
  fpsCap: 15,
  wanderEnabled: false,
  wanderToActiveWindow: false,
  wanderCorners: ["bottom-right", "bottom-left"],
  wanderWaitMinSeconds: 45,
  wanderWaitMaxSeconds: 90
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
  const wanderWaitMinSeconds = boundedNumber(row.wanderWaitMinSeconds, 45, 5, 3600);
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
    bubbleStyle: normalizeDesktopPetBubbleStyle(row.bubbleStyle),
    fpsCap: fps,
    wanderEnabled: row.wanderEnabled === true,
    wanderToActiveWindow: row.wanderToActiveWindow === true,
    wanderCorners: Array.isArray(row.wanderCorners)
      ? DESKTOP_PET_CORNERS.filter(corner => (row.wanderCorners as unknown[]).includes(corner.id)).map(corner => corner.id)
      : [...DEFAULT_DESKTOP_PET_BINDING.wanderCorners],
    wanderWaitMinSeconds,
    wanderWaitMaxSeconds: boundedNumber(row.wanderWaitMaxSeconds, 90, wanderWaitMinSeconds, 3600)
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
