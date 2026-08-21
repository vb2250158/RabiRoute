export const DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S";
export const DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT = "F3";

export type DesktopScreenshotSettings = {
  enabled: boolean;
  shortcut: string;
  clipboardShortcut: string;
  autoCopy: boolean;
};

export const DESKTOP_THEME_OPTIONS = ["system", "light", "dark"] as const;
export type DesktopTheme = typeof DESKTOP_THEME_OPTIONS[number];

export type DesktopSettings = {
  screenshot: DesktopScreenshotSettings;
  autostart: boolean;
  theme: DesktopTheme;
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  screenshot: {
    enabled: false,
    shortcut: DEFAULT_SCREENSHOT_SHORTCUT,
    clipboardShortcut: DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT,
    autoCopy: true
  },
  autostart: false,
  theme: "system"
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function desktopTheme(value: unknown): DesktopTheme {
  return typeof value === "string" && (DESKTOP_THEME_OPTIONS as readonly string[]).includes(value)
    ? value as DesktopTheme
    : "system";
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const screenshot = row.screenshot && typeof row.screenshot === "object" && !Array.isArray(row.screenshot)
    ? row.screenshot as Record<string, unknown>
    : {};
  return {
    screenshot: {
      enabled: screenshot.enabled === true,
      shortcut: text(screenshot.shortcut) || DEFAULT_SCREENSHOT_SHORTCUT,
      clipboardShortcut: text(screenshot.clipboardShortcut) || DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT,
      autoCopy: screenshot.autoCopy !== false
    },
    autostart: row.autostart === true,
    theme: desktopTheme(row.theme)
  };
}
