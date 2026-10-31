import { ReadSettingsError } from "./readSettingsError.js";
/** Zero byte quotas mean no application limit; actual runtime capacity still applies. */
function createPersonaReadSettings(env: NodeJS.ProcessEnv = process.env) {
  const bytes = (name: string) => {
    const raw = env[name]?.trim(); const value = raw ? Number(raw) : 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new ReadSettingsError(name, "must be a nonnegative safe integer; 0 removes the application quota.");
    return value;
  };
  return Object.freeze({
    get documentBytes() { return bytes("RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES"); },
    get configBytes() { return bytes("RABIROUTE_PERSONA_CONFIG_MAX_BYTES"); },
    get responseBytes() { return bytes("RABIROUTE_PERSONA_RESPONSE_MAX_BYTES"); }
  });
}
export function readPersonaReadSettings(env: NodeJS.ProcessEnv = process.env) {
  const settings = createPersonaReadSettings(env); Object.values(settings); return settings;
}
export const personaReadSettings = createPersonaReadSettings();
