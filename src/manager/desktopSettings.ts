import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  type DesktopSettings
} from "../shared/desktopSettingsContract.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

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
    const previous = this.read();
    const settings = normalizeDesktopSettings(value);
    try {
      atomicWriteFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
      const changedFields = Object.keys(settings as unknown as Record<string, unknown>)
        .filter(key => JSON.stringify((previous as unknown as Record<string, unknown>)[key]) !== JSON.stringify((settings as unknown as Record<string, unknown>)[key]));
      recordDataMutationAudit({
        group: "config.desktop",
        event: "desktop_settings_updated",
        owner: "DesktopSettingsStore",
        action: "write",
        target: { type: "desktop_settings", id: "settings" },
        dataSource: { kind: "file", id: "data/desktop/settings.json" },
        outcome: changedFields.length ? "committed" : "no_change",
        changes: changedFields.map(field => ({ field }))
      });
      return settings;
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "config.desktop",
        event: "desktop_settings_update_failed",
        owner: "DesktopSettingsStore",
        action: "write",
        target: { type: "desktop_settings", id: "settings" },
        dataSource: { kind: "file", id: "data/desktop/settings.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
  }
}
