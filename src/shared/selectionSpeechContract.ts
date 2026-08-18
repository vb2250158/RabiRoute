import type { SpeechModel } from "./speechControlContract.js";

export const SELECTION_SPEECH_MAX_LENGTH = 10_000;

export type SelectionSpeechSettings = {
  enabled: boolean;
  advanced: boolean;
  model: string;
};

export const DEFAULT_SELECTION_SPEECH_SETTINGS: SelectionSpeechSettings = {
  enabled: false,
  advanced: false,
  model: ""
};

export function normalizeSelectionSpeechSettings(value: unknown): SelectionSpeechSettings {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: row.enabled === true,
    advanced: row.advanced === true,
    model: typeof row.model === "string" ? row.model.trim().slice(0, 200) : ""
  };
}

export function resolveSelectionSpeechModel(
  settings: SelectionSpeechSettings,
  models: SpeechModel[]
): string {
  const available = models.filter(model => model.capability === "tts" && model.available);
  if (settings.advanced && settings.model && available.some(model => model.id === settings.model)) {
    return settings.model;
  }
  return available.find(model => model.isDefault)?.id || available[0]?.id || "";
}
