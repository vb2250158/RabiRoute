/** Shared wire identity and object bounds for both stores behind the resources API. */
export const RESOURCE_OBJECT_MAX_BYTES = 1024 * 1024;
export const RESOURCE_ID_PATTERN = "^[A-Za-z0-9_-]{1,128}$";
export const RESOURCE_HASH_PATTERN = "^[a-f0-9]{64}$";
export const RESOURCE_NAMESPACE_PATTERN = "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
export const RESOURCE_ZERO_NAMESPACE = "00000000-0000-0000-0000-000000000000";
export const RESOURCE_SETTINGS_MAX_BYTES = 8192;
export const RESOURCE_DIRECTORY_MAX_LENGTH = 2048;
export const MOBILE_RECORDING_MAX_CHUNKS = 16;
export const MOBILE_RECORDING_TEXT_MAX_CODE_UNITS = 100_000;
export const MOBILE_RECORDING_EVENT_ID_PATTERN = "^[A-Za-z0-9_-]{1,200}$";
export const MOBILE_RECORDING_TRANSCRIPTION_STATES = ["pending", "processing", "ready", "empty", "error"] as const;
export const resourceIdentitySchema = { type: "string", pattern: RESOURCE_ID_PATTERN };
export const resourceHashSchema = { type: "string", pattern: RESOURCE_HASH_PATTERN };
export const resourceNamespaceSchema = { type: "string", pattern: RESOURCE_NAMESPACE_PATTERN, not: { const: RESOURCE_ZERO_NAMESPACE } };
const resourceOwnerPattern = new RegExp(RESOURCE_ID_PATTERN);
export function resourceOwnerId(value: unknown): string | null { return typeof value === "string" && resourceOwnerPattern.test(value) ? value : null; }
export function freezeResourceSchema<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeResourceSchema(child);
    Object.freeze(value);
  }
  return value;
}
export function exactResourceObject<T extends Record<string, unknown>>(properties: T) {
  return freezeResourceSchema({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
}
