import { BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, createComputerSettingsDefinition } from "./computer-control-contract.mjs";

const freezeData = value => {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freezeData(item); Object.freeze(value); }
  return value;
};

/** Execution metadata from the original authenticated Manager connection, not a second settings store. */
export class ComputerSettingsReplica {
  constructor({ create = createComputerSettingsDefinition } = {}) {
    this.create = create;
    this.current = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION;
    this.raw = Object.freeze({});
  }
  apply(frame = {}) {
    let issue;
    if (frame.settingsDefinition && frame.settingsDefinition.digest !== this.current.digest) {
      try { this.current = this.create(frame.settingsDefinition.data, frame.settingsDefinition.digest); }
      catch (error) { issue = error instanceof Error ? error.message : String(error); }
    }
    // Do not normalize advanced fields before the target's original receipt lookup.
    if (Object.hasOwn(frame, "settings")) this.raw = freezeData(structuredClone(frame.settings));
    return { digest: this.current.digest, ...(issue ? { issue } : {}) };
  }
  readRaw() { return this.raw; }
  definition() { return this.current; }
}
