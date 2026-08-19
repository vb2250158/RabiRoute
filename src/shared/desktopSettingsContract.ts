export const DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S";

export type DesktopScreenshotSettings = {
  enabled: boolean;
  shortcut: string;
};

export type DesktopSettings = {
  screenshot: DesktopScreenshotSettings;
  autostart: boolean;
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  screenshot: {
    enabled: false,
    shortcut: DEFAULT_SCREENSHOT_SHORTCUT
  },
  autostart: false
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
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
      shortcut: text(screenshot.shortcut) || DEFAULT_SCREENSHOT_SHORTCUT
    },
    autostart: row.autostart === true
  };
}
