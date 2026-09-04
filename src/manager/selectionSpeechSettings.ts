import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  DEFAULT_SELECTION_SPEECH_SETTINGS,
  normalizeSelectionSpeechSettings,
  type SelectionSpeechSettings
} from "../shared/selectionSpeechContract.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export function selectionSpeechSettingsPath(rootDir: string): string {
  return path.join(rootDir, "data", "speech", "selection-reader-settings.json");
}

export class SelectionSpeechSettingsStore {
  constructor(private readonly filePath: string) {}

  read(): SelectionSpeechSettings {
    if (!fs.existsSync(this.filePath)) return { ...DEFAULT_SELECTION_SPEECH_SETTINGS };
    try {
      return normalizeSelectionSpeechSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "")));
    } catch {
      return { ...DEFAULT_SELECTION_SPEECH_SETTINGS };
    }
  }

  write(value: unknown): SelectionSpeechSettings {
    const previous = this.read();
    const settings = normalizeSelectionSpeechSettings(value);
    try {
      atomicWriteFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
      const changedFields = Object.keys(settings as unknown as Record<string, unknown>)
        .filter(key => JSON.stringify((previous as unknown as Record<string, unknown>)[key]) !== JSON.stringify((settings as unknown as Record<string, unknown>)[key]));
      recordDataMutationAudit({
        group: "config.speech",
        event: "selection_speech_settings_updated",
        owner: "SelectionSpeechSettingsStore",
        action: "write",
        target: { type: "selection_speech_settings", id: "selection-reader" },
        dataSource: { kind: "file", id: "data/speech/selection-reader-settings.json" },
        outcome: changedFields.length ? "committed" : "no_change",
        changes: changedFields.map(field => ({ field }))
      });
      return settings;
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "config.speech",
        event: "selection_speech_settings_update_failed",
        owner: "SelectionSpeechSettingsStore",
        action: "write",
        target: { type: "selection_speech_settings", id: "selection-reader" },
        dataSource: { kind: "file", id: "data/speech/selection-reader-settings.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
  }
}
