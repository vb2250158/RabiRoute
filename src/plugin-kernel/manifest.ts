import { PLUGIN_HOSTS, type PluginEntries, type PluginHost, type PluginManifest } from "./types.js";
import { isPluginCapabilityReference } from "./capabilityReference.js";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}
function identifier(value: unknown, field: string): string {
  const normalized = text(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}
function version(value: unknown): string {
  const normalized = text(value, "Plugin version", 80);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(normalized)) throw new Error("Plugin version is invalid.");
  return normalized;
}
function capability(value: unknown, field: string): string {
  const normalized = text(value, field, 200);
  if (!isPluginCapabilityReference(normalized)) throw new Error(`${field} must use name@major format.`);
  return normalized;
}
function permission(value: unknown, field: string): string {
  const normalized = text(value, field, 160);
  if (!/^[a-z][a-z0-9._:-]*$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}
function uniqueStrings(value: unknown, field: string, parse: (item: unknown, itemField: string) => string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const normalized = value.map((item, index) => parse(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} contains duplicates.`);
  return Object.freeze(normalized);
}
function entry(value: unknown, host: PluginHost): string {
  const normalized = text(value, `Plugin entries.${host}`, 240).replace(/\\/g, "/");
  if (!normalized.startsWith("./") || normalized.endsWith("/") || normalized.includes("../")) {
    throw new Error(`Plugin entries.${host} must be a relative file inside its package.`);
  }
  return normalized;
}
function entries(value: unknown): PluginEntries {
  const raw = record(value, "Plugin entries");
  const supported = new Set<string>(PLUGIN_HOSTS);
  const unknown = Object.keys(raw).filter(key => !supported.has(key));
  if (unknown.length) throw new Error(`Plugin entries contain unsupported hosts: ${unknown.sort().join(", ")}.`);
  const normalized: Partial<Record<PluginHost, string>> = {};
  for (const host of PLUGIN_HOSTS) if (raw[host] !== undefined) normalized[host] = entry(raw[host], host);
  if (!Object.keys(normalized).length) throw new Error("Plugin entries must declare at least one host.");
  return Object.freeze(normalized);
}
function configSchema(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : Object.freeze({ ...record(value, "Plugin configSchema") });
}
function stateSchemaVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Plugin stateSchemaVersion must be a positive integer.");
  return value as number;
}
export function parsePluginManifest(value: unknown): PluginManifest {
  const raw = record(value, "Plugin manifest");
  const allowed = new Set(["schemaVersion", "id", "version", "entries", "provides", "requires", "optional", "permissions", "configSchema", "stateSchemaVersion"]);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Plugin manifest contains unsupported fields: ${unknown.sort().join(", ")}.`);
  if (raw.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) throw new Error(`Unsupported plugin manifest schema: ${String(raw.schemaVersion)}.`);
  const provides = uniqueStrings(raw.provides, "Plugin provides", capability);
  const requires = uniqueStrings(raw.requires, "Plugin requires", capability);
  const optional = uniqueStrings(raw.optional, "Plugin optional", capability);
  const overlap = [...requires, ...optional].filter(item => provides.includes(item));
  if (overlap.length) throw new Error(`Plugin cannot consume capabilities it provides: ${[...new Set(overlap)].join(", ")}.`);
  const parsedConfigSchema = configSchema(raw.configSchema);
  const parsedStateSchemaVersion = stateSchemaVersion(raw.stateSchemaVersion);
  return Object.freeze({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: identifier(raw.id, "Plugin id"),
    version: version(raw.version),
    entries: entries(raw.entries),
    provides,
    requires,
    optional,
    permissions: uniqueStrings(raw.permissions, "Plugin permissions", permission),
    ...(parsedConfigSchema ? { configSchema: parsedConfigSchema } : {}),
    ...(parsedStateSchemaVersion ? { stateSchemaVersion: parsedStateSchemaVersion } : {})
  });
}
export function capabilityMajor(capabilityRef: string): number {
  const match = capabilityRef.match(/@([1-9][0-9]*)$/);
  if (!match) throw new Error(`Capability must use name@major format: ${capabilityRef}.`);
  return Number(match[1]);
}

