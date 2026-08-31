import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  type DesktopSettings
} from "../shared/desktopSettingsContract.js";

export function desktopSettingsPath(rootDir: string): string {
  return path.join(rootDir, "data", "desktop", "settings.json");
}

export class DesktopSettingsStore {
  constructor(private readonly filePath: string) {}

  autostartConfigured(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""));
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof value.autostart === "boolean");
    } catch {
      return false;
    }
  }

  read(): DesktopSettings {
    if (!fs.existsSync(this.filePath)) return structuredClone(DEFAULT_DESKTOP_SETTINGS);
    try {
      return normalizeDesktopSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "")));
    } catch {
      return structuredClone(DEFAULT_DESKTOP_SETTINGS);
    }
  }

  write(value: unknown): DesktopSettings {
    const settings = normalizeDesktopSettings(value);
    atomicWriteFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
}
