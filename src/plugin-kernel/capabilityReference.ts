export const PLUGIN_CAPABILITY_REFERENCE_MAX_LENGTH = 200;

/** A plugin capability always carries an explicit positive major version: name@major. */
export function isPluginCapabilityReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= PLUGIN_CAPABILITY_REFERENCE_MAX_LENGTH
    && /^[a-z][a-z0-9._:-]*@[1-9][0-9]*$/.test(value);
}
