import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RABI_PLUGIN_PROFILE_SCHEMA_VERSION = 1;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RabiPluginProfileEntry = Readonly<{
  id: string;
  package: string;
  version: string;
  enabled: boolean;
  config: JsonValue;
}>;

export type RabiPluginProfile = Readonly<{
  schemaVersion: 1;
  plugins: readonly RabiPluginProfileEntry[];
}>;

export type RabiPluginProfilePatch = Readonly<{
  schemaVersion: 1;
  operations: readonly (
    | Readonly<{ op: "upsert"; plugin: RabiPluginProfileEntry }>
    | Readonly<{ op: "remove"; id: string }>
  )[];
}>;

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

function id(value: unknown, field: string): string {
  const normalized = text(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

function pluginVersion(value: unknown, field: string): string {
  const normalized = text(value, field, 80);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

function json(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} is invalid.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${field}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, json(item, `${field}.${key}`)]));
  }
  throw new Error(`${field} is invalid.`);
}

function entry(value: unknown, field = "Plugin profile entry"): RabiPluginProfileEntry {
  const raw = record(value, field);
  const allowed = new Set(["id", "package", "version", "enabled", "config"]);
  const unsupported = Object.keys(raw).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`${field} has unsupported fields: ${unsupported.sort().join(", ")}.`);
  return Object.freeze({
    id: id(raw.id, `${field}.id`),
    package: id(raw.package, `${field}.package`),
    version: pluginVersion(raw.version, `${field}.version`),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    config: raw.config === undefined ? Object.freeze({}) : json(raw.config, `${field}.config`)
  });
}

function unique(entries: readonly RabiPluginProfileEntry[]): readonly RabiPluginProfileEntry[] {
  const known = new Set<string>();
  for (const item of entries) {
    if (known.has(item.id)) throw new Error(`Duplicate plugin profile entry: ${item.id}.`);
    known.add(item.id);
  }
  return Object.freeze([...entries]);
}

export function parseRabiPluginProfile(value: unknown): RabiPluginProfile {
  const raw = record(value, "Plugin profile");
  const unsupported = Object.keys(raw).filter(key => key !== "schemaVersion" && key !== "plugins");
  if (unsupported.length) throw new Error(`Plugin profile has unsupported fields: ${unsupported.sort().join(", ")}.`);
  if (raw.schemaVersion !== RABI_PLUGIN_PROFILE_SCHEMA_VERSION) throw new Error(`Unsupported plugin profile schema: ${String(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.plugins)) throw new Error("Plugin profile plugins must be an array.");
  return Object.freeze({
    schemaVersion: RABI_PLUGIN_PROFILE_SCHEMA_VERSION,
    plugins: unique(raw.plugins.map((item, index) => entry(item, `Plugin profile plugins[${index}]`)))
  });
}

export function parseRabiPluginProfilePatch(value: unknown): RabiPluginProfilePatch {
  const raw = record(value, "Plugin profile patch");
  const unsupported = Object.keys(raw).filter(key => key !== "schemaVersion" && key !== "operations");
  if (unsupported.length) throw new Error(`Plugin profile patch has unsupported fields: ${unsupported.sort().join(", ")}.`);
  if (raw.schemaVersion !== RABI_PLUGIN_PROFILE_SCHEMA_VERSION) throw new Error(`Unsupported plugin profile patch schema: ${String(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.operations)) throw new Error("Plugin profile patch operations must be an array.");
  const operations = raw.operations.map((value, index) => {
    const operation = record(value, `Plugin profile patch operations[${index}]`);
    if (operation.op === "upsert") {
      if (Object.keys(operation).some(key => key !== "op" && key !== "plugin")) throw new Error(`Plugin profile patch operations[${index}] is invalid.`);
      return Object.freeze({ op: "upsert" as const, plugin: entry(operation.plugin, `Plugin profile patch operations[${index}].plugin`) });
    }
    if (operation.op === "remove") {
      if (Object.keys(operation).some(key => key !== "op" && key !== "id")) throw new Error(`Plugin profile patch operations[${index}] is invalid.`);
      return Object.freeze({ op: "remove" as const, id: id(operation.id, `Plugin profile patch operations[${index}].id`) });
    }
    throw new Error(`Plugin profile patch operations[${index}].op is unsupported.`);
  });
  return Object.freeze({ schemaVersion: RABI_PLUGIN_PROFILE_SCHEMA_VERSION, operations: Object.freeze(operations) });
}

export function applyRabiPluginProfilePatches(
  profile: RabiPluginProfile,
  patches: readonly RabiPluginProfilePatch[]
): RabiPluginProfile {
  const plugins = new Map(profile.plugins.map(item => [item.id, item]));
  for (const patch of patches) {
    for (const operation of patch.operations) {
      if (operation.op === "remove") plugins.delete(operation.id);
      else plugins.set(operation.plugin.id, operation.plugin);
    }
  }
  return Object.freeze({ schemaVersion: RABI_PLUGIN_PROFILE_SCHEMA_VERSION, plugins: unique([...plugins.values()]) });
}

export async function readRabiPluginProfile(profilePath: string, patchDirectory?: string): Promise<RabiPluginProfile> {
  const profile = parseRabiPluginProfile(JSON.parse(await fs.readFile(profilePath, "utf8")) as unknown);
  if (!patchDirectory) return profile;
  const entries = await fs.readdir(patchDirectory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const patches = await Promise.all(entries
    .filter(item => item.isFile() && item.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async item => parseRabiPluginProfilePatch(JSON.parse(await fs.readFile(path.join(patchDirectory, item.name), "utf8")) as unknown)));
  return applyRabiPluginProfilePatches(profile, patches);
}

function canonical(value: JsonValue): string {
  return JSON.stringify(value);
}

export function rabiPluginProfileEntryRevision(entry: RabiPluginProfileEntry, bundleRevision: string): string {
  return createHash("sha256")
    .update(canonical({ id: entry.id, package: entry.package, version: entry.version, enabled: entry.enabled, config: entry.config }), "utf8")
    .update("\0", "utf8")
    .update(bundleRevision, "utf8")
    .digest("hex");
}
