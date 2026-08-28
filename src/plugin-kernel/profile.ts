import fs from "node:fs/promises";
import path from "node:path";
import { loadPluginPackage, type LoadedPluginPackage } from "./packageLoader.js";
import type { PluginCandidate, PluginHost, PluginIdentity } from "./types.js";

export type PluginProfileEntry = Readonly<{
  id: string;
  package: string;
  version: string;
  enabled: boolean;
  config: unknown;
  grants: readonly string[];
}>;
export type PluginProfile = Readonly<{ schemaVersion: 1; instances: readonly PluginProfileEntry[] }>;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.trim())) throw new Error(`${field} is invalid.`);
  return value.trim();
}
function version(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(value.trim())) throw new Error(`${field} is invalid.`);
  return value.trim();
}
function grants(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const normalized = value.map((item, index) => id(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} contains duplicates.`);
  return Object.freeze(normalized);
}
function json(value: unknown): unknown { return value === undefined ? Object.freeze({}) : structuredClone(value); }

export function parsePluginProfile(value: unknown): PluginProfile {
  const raw = record(value, "Plugin profile");
  const unknown = Object.keys(raw).filter(key => key !== "schemaVersion" && key !== "instances");
  if (unknown.length) throw new Error(`Plugin profile contains unsupported fields: ${unknown.sort().join(", ")}.`);
  if (raw.schemaVersion !== 1) throw new Error(`Unsupported plugin profile schema: ${String(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.instances)) throw new Error("Plugin profile instances must be an array.");
  const seen = new Set<string>();
  const instances = raw.instances.map((value, index) => {
    const item = record(value, `Plugin profile instances[${index}]`);
    const unsupported = Object.keys(item).filter(key => !["id", "package", "version", "enabled", "config", "grants"].includes(key));
    if (unsupported.length) throw new Error(`Plugin profile instances[${index}] contains unsupported fields: ${unsupported.join(", ")}.`);
    const instanceId = id(item.id, `Plugin profile instances[${index}].id`);
    if (seen.has(instanceId)) throw new Error(`Duplicate plugin profile instance: ${instanceId}.`);
    seen.add(instanceId);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`Plugin profile instances[${index}].enabled must be a boolean.`);
    return Object.freeze({
      id: instanceId,
      package: id(item.package, `Plugin profile instances[${index}].package`),
      version: version(item.version, `Plugin profile instances[${index}].version`),
      enabled: item.enabled !== false,
      config: json(item.config),
      grants: grants(item.grants, `Plugin profile instances[${index}].grants`)
    });
  });
  return Object.freeze({ schemaVersion: 1, instances: Object.freeze(instances) });
}

export async function readPluginProfile(profilePath: string): Promise<PluginProfile> {
  return parsePluginProfile(JSON.parse(await fs.readFile(profilePath, "utf8")) as unknown);
}

export class PluginPackageCatalog {
  readonly #roots: readonly string[];
  constructor(roots: readonly string[]) {
    if (!roots.length) throw new Error("At least one plugin package root is required.");
    this.#roots = Object.freeze(roots.map(root => path.resolve(root)));
  }
  async resolve(packageId: string, packageVersion: string): Promise<string> {
    for (const root of this.#roots) {
      const candidate = path.join(root, encodeURIComponent(packageId), packageVersion);
      try { if ((await fs.stat(candidate)).isDirectory()) return candidate; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Plugin package is not installed: ${packageId}@${packageVersion}.`);
  }
}

export type LoadedPluginProfile = Readonly<{
  profile: PluginProfile;
  candidates: readonly PluginCandidate[];
  packages: readonly Readonly<{ instance: PluginProfileEntry; package: LoadedPluginPackage }>[];
  grants(identity: PluginIdentity): readonly string[];
}>;

export async function loadPluginProfile(input: Readonly<{
  profilePath: string;
  packageCatalog: PluginPackageCatalog;
  runtimeRoot: string;
  host: PluginHost;
}>): Promise<LoadedPluginProfile> {
  const profile = await readPluginProfile(input.profilePath);
  const enabled = profile.instances.filter(instance => instance.enabled);
  const loaded = await Promise.all(enabled.map(async instance => {
    const sourceRoot = await input.packageCatalog.resolve(instance.package, instance.version);
    const plugin = await loadPluginPackage(sourceRoot, input.runtimeRoot, input.host);
    if (plugin.manifest.id !== instance.package || plugin.manifest.version !== instance.version) {
      throw new Error(`Plugin profile identity does not match package manifest: ${instance.id}.`);
    }
    return Object.freeze({
      instance,
      package: plugin,
      candidate: Object.freeze({
        instanceId: instance.id,
        revision: plugin.revision,
        manifest: plugin.manifest,
        config: instance.config,
        module: plugin.module
      }) satisfies PluginCandidate
    });
  }));
  const grantsById = new Map(enabled.map(instance => [instance.id, instance.grants]));
  return Object.freeze({
    profile,
    candidates: Object.freeze(loaded.map(item => item.candidate)),
    packages: Object.freeze(loaded.map(({ instance, package: pluginPackage }) => Object.freeze({ instance, package: pluginPackage }))),
    grants(identity: PluginIdentity): readonly string[] { return grantsById.get(identity.instanceId) ?? Object.freeze([]); }
  });
}


