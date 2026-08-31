import fs from "node:fs/promises";
import path from "node:path";
import { loadPluginPackage, type LoadedPluginPackage } from "./packageLoader.js";
import { isPluginCapabilityReference } from "./capabilityReference.js";
import type {
  PluginCandidate,
  PluginHost,
  PluginIdentity,
  PluginInstancePolicy,
  PluginRestartPolicy,
  PluginResourcePolicy
} from "./types.js";

export type PluginProfileEntry = Readonly<{
  id: string;
  package: string;
  version: string;
  enabled: boolean;
  config: unknown;
  grants: readonly string[];
  policy: PluginInstancePolicy;
}>;
export type PluginProfile = Readonly<{
  schemaVersion: 2;
  readyRequires: readonly string[];
  instances: readonly PluginProfileEntry[];
}>;

const DEFAULT_RESTART_POLICY: PluginRestartPolicy = Object.freeze({
  mode: "never", maxAttempts: 0, windowMs: 60_000, initialBackoffMs: 500, maximumBackoffMs: 10_000
});
const DEFAULT_RESOURCE_POLICY: PluginResourcePolicy = Object.freeze({
  maxChildProcesses: 2, shutdownTimeoutMs: 5_000
});

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
function boundedInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}
function policy(value: unknown, field: string): PluginInstancePolicy {
  if (value === undefined) return Object.freeze({ restart: DEFAULT_RESTART_POLICY, resources: DEFAULT_RESOURCE_POLICY });
  const raw = record(value, field);
  const unknown = Object.keys(raw).filter(key => key !== "restart" && key !== "resources");
  if (unknown.length) throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}.`);
  const restartRaw = raw.restart === undefined ? {} : record(raw.restart, `${field}.restart`);
  const restartUnknown = Object.keys(restartRaw).filter(key => !["mode", "maxAttempts", "windowMs", "initialBackoffMs", "maximumBackoffMs"].includes(key));
  if (restartUnknown.length) throw new Error(`${field}.restart contains unsupported fields: ${restartUnknown.join(", ")}.`);
  const mode = restartRaw.mode === undefined ? "never" : String(restartRaw.mode);
  if (mode !== "never" && mode !== "on_failure") throw new Error(`${field}.restart.mode is invalid.`);
  const restart = Object.freeze({
    mode,
    maxAttempts: boundedInteger(restartRaw.maxAttempts, `${field}.restart.maxAttempts`, 0, 100, mode === "never" ? 0 : 3),
    windowMs: boundedInteger(restartRaw.windowMs, `${field}.restart.windowMs`, 1_000, 86_400_000, DEFAULT_RESTART_POLICY.windowMs),
    initialBackoffMs: boundedInteger(restartRaw.initialBackoffMs, `${field}.restart.initialBackoffMs`, 0, 60_000, DEFAULT_RESTART_POLICY.initialBackoffMs),
    maximumBackoffMs: boundedInteger(restartRaw.maximumBackoffMs, `${field}.restart.maximumBackoffMs`, 1, 300_000, DEFAULT_RESTART_POLICY.maximumBackoffMs)
  }) satisfies PluginRestartPolicy;
  if (restart.mode === "never" && restart.maxAttempts !== 0) throw new Error(`${field}.restart.maxAttempts must be 0 when restart mode is never.`);
  if (restart.maximumBackoffMs < restart.initialBackoffMs) throw new Error(`${field}.restart.maximumBackoffMs must not be less than initialBackoffMs.`);
  const resourcesRaw = raw.resources === undefined ? {} : record(raw.resources, `${field}.resources`);
  const resourcesUnknown = Object.keys(resourcesRaw).filter(key => !["maxChildProcesses", "shutdownTimeoutMs"].includes(key));
  if (resourcesUnknown.length) throw new Error(`${field}.resources contains unsupported fields: ${resourcesUnknown.join(", ")}.`);
  const resources = Object.freeze({
    maxChildProcesses: boundedInteger(resourcesRaw.maxChildProcesses, `${field}.resources.maxChildProcesses`, 0, 64, DEFAULT_RESOURCE_POLICY.maxChildProcesses),
    shutdownTimeoutMs: boundedInteger(resourcesRaw.shutdownTimeoutMs, `${field}.resources.shutdownTimeoutMs`, 100, 120_000, DEFAULT_RESOURCE_POLICY.shutdownTimeoutMs)
  });
  return Object.freeze({ restart, resources });
}
function readyRequires(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Plugin profile readyRequires must be an array.");
  const normalized = value.map((item, index) => {
    if (typeof item !== "string" || !isPluginCapabilityReference(item.trim())) {
      throw new Error(`Plugin profile readyRequires[${index}] must use name@major format.`);
    }
    return item.trim();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Plugin profile readyRequires contains duplicates.");
  return Object.freeze(normalized);
}

function isInsidePackageRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function parsePluginProfile(value: unknown): PluginProfile {
  const raw = record(value, "Plugin profile");
  const unknown = Object.keys(raw).filter(key => !["schemaVersion", "readyRequires", "instances"].includes(key));
  if (unknown.length) throw new Error(`Plugin profile contains unsupported fields: ${unknown.sort().join(", ")}.`);
  if (raw.schemaVersion !== 2) throw new Error(`Unsupported plugin profile schema: ${String(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.instances)) throw new Error("Plugin profile instances must be an array.");
  const seen = new Set<string>();
  const instances = raw.instances.map((value, index) => {
    const item = record(value, `Plugin profile instances[${index}]`);
    const unsupported = Object.keys(item).filter(key => !["id", "package", "version", "enabled", "config", "grants", "policy"].includes(key));
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
      grants: grants(item.grants, `Plugin profile instances[${index}].grants`),
      policy: policy(item.policy, `Plugin profile instances[${index}].policy`)
    });
  });
  return Object.freeze({ schemaVersion: 2, readyRequires: readyRequires(raw.readyRequires), instances: Object.freeze(instances) });
}

export async function readPluginProfile(profilePath: string): Promise<PluginProfile> {
  return parsePluginProfile(JSON.parse(await fs.readFile(profilePath, "utf8")) as unknown);
}

export class PluginPackageCatalog {
  readonly #roots: readonly Readonly<{ path: string; inProcessTrusted: boolean }>[];
  constructor(
    roots: readonly string[],
    options: Readonly<{ trustedInProcessRoots?: readonly string[] }> = {}
  ) {
    if (!roots.length) throw new Error("At least one plugin package root is required.");
    const trustedRoots = new Set((options.trustedInProcessRoots ?? []).map(root => path.resolve(root)));
    const normalizedRoots = roots.map(root => path.resolve(root));
    for (const trustedRoot of trustedRoots) {
      if (!normalizedRoots.includes(trustedRoot)) {
        throw new Error(`Trusted in-process plugin root is not present in the package catalog: ${trustedRoot}.`);
      }
    }
    this.#roots = Object.freeze(normalizedRoots.map(root => Object.freeze({
      path: root,
      inProcessTrusted: trustedRoots.has(root)
    })));
  }
  async resolve(packageId: string, packageVersion: string): Promise<Readonly<{ sourceRoot: string; inProcessTrusted: boolean }>> {
    for (const root of this.#roots) {
      const candidate = path.join(root.path, encodeURIComponent(packageId), packageVersion);
      try {
        if ((await fs.stat(candidate)).isDirectory()) {
          const [canonicalRoot, canonicalCandidate] = await Promise.all([fs.realpath(root.path), fs.realpath(candidate)]);
          if (!isInsidePackageRoot(canonicalRoot, canonicalCandidate)) {
            throw new Error(`Plugin package escapes its catalog root: ${packageId}@${packageVersion}.`);
          }
          return Object.freeze({ sourceRoot: canonicalCandidate, inProcessTrusted: root.inProcessTrusted });
        }
      } catch (error) {
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
    const resolvedPackage = await input.packageCatalog.resolve(instance.package, instance.version);
    const plugin = await loadPluginPackage(resolvedPackage.sourceRoot, input.runtimeRoot, input.host);
    if (plugin.manifest.id !== instance.package || plugin.manifest.version !== instance.version) {
      throw new Error(`Plugin profile identity does not match package manifest: ${instance.id}.`);
    }
    if (plugin.execution === "in_process" && !resolvedPackage.inProcessTrusted) {
      throw new Error(
        `Plugin package root is not trusted for in_process execution: ${instance.package}@${instance.version}. `
        + "External packages must use isolated or declarative execution."
      );
    }
    return Object.freeze({
      instance,
      package: plugin,
      candidate: Object.freeze({
        instanceId: instance.id,
        revision: plugin.revision,
        manifest: plugin.manifest,
        config: instance.config,
        entry: Object.freeze({ execution: plugin.execution, path: plugin.entryPath }),
        policy: instance.policy
      }) satisfies PluginCandidate
    });
  }));
  const grantsById = new Map(enabled.map(instance => [instance.id, instance.grants]));
  return Object.freeze({
    profile,
    candidates: Object.freeze(loaded.map(item => item.candidate)),
    packages: Object.freeze(loaded.map(({ instance, package: pluginPackage }) => Object.freeze({ instance, package: pluginPackage }))),
    grants(identity: Pick<PluginIdentity, "instanceId">): readonly string[] { return grantsById.get(identity.instanceId) ?? Object.freeze([]); }
  });
}


