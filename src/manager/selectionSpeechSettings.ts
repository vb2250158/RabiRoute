import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  DEFAULT_SELECTION_SPEECH_SETTINGS,
  normalizeSelectionSpeechSettings,
  type SelectionSpeechSettings
} from "../shared/selectionSpeechContract.js";

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
    const settings = normalizeSelectionSpeechSettings(value);
    atomicWriteFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
}
