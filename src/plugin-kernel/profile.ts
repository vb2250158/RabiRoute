import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PluginExecutionConfigurationDiagnostic } from "./pluginExecutionSettings.js";
import type { LoadedPluginPackage } from "./packageLoader.js";
import { PluginPackageLoader, type PluginPackageLoadingOptions } from "./pluginPackageLoader.js";
import { isPluginCapabilityReference } from "./capabilityReference.js";
import type {
  PluginCandidate,
  PluginHost,
  PluginIdentity,
  PluginInstancePolicy,
  PluginRestartPolicy,
  PluginResourcePolicy
} from "./types.js";

// PackageCatalog's already verified immutable owner proof follows the exact
// candidate object. Keeping it out of JSON prevents a caller from substituting
// an arbitrary dirname/revision as a transport package proof.
const candidatePackages = new WeakMap<PluginCandidate, LoadedPluginPackage>();
export function pluginPackageForCandidate(candidate: PluginCandidate): LoadedPluginPackage | undefined {
  return candidatePackages.get(candidate);
}

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
  diagnostics?: readonly PluginProfileDiagnostic[];
  migrations?: readonly PluginProfileMigration[];
}>;
export type PluginProfileDiagnostic = Readonly<{
  source: "profile" | "package-migrations";
  rowIndex: number;
  instanceId?: string;
  packageId?: string;
  version?: string;
  message: string;
}>;
export type PluginProfileMigration = Readonly<{
  instanceId: string;
  packageId: string;
  fromVersion: string;
  toVersion: string;
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
function packageRootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parsePluginProfile(value: unknown): PluginProfile {
  const raw = record(value, "Plugin profile");
  const unknown = Object.keys(raw).filter(key => !["schemaVersion", "readyRequires", "instances"].includes(key));
  if (unknown.length) throw new Error(`Plugin profile contains unsupported fields: ${unknown.sort().join(", ")}.`);
  if (raw.schemaVersion !== 2) throw new Error(`Unsupported plugin profile schema: ${String(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.instances)) throw new Error("Plugin profile instances must be an array.");
  const rows = raw.instances;
  const identities = rows.map(value => {
    try { return id(record(value, "Plugin profile instance").id, "Plugin profile instance.id"); }
    catch { return undefined; }
  });
  const counts = new Map<string, number>();
  for (const identity of identities) if (identity) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  const diagnostics: PluginProfileDiagnostic[] = [];
  const instances: PluginProfileEntry[] = [];
  rows.forEach((value, index) => {
    try {
      const item = record(value, `Plugin profile instances[${index}]`);
      const unsupported = Object.keys(item).filter(key => !["id", "package", "version", "enabled", "config", "grants", "policy"].includes(key));
      if (unsupported.length) throw new Error(`Plugin profile instances[${index}] contains unsupported fields: ${unsupported.join(", ")}.`);
      const instanceId = id(item.id, `Plugin profile instances[${index}].id`);
      if (counts.get(instanceId)! > 1) throw new Error(`Duplicate plugin profile instance: ${instanceId}.`);
      if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`Plugin profile instances[${index}].enabled must be a boolean.`);
      instances.push(Object.freeze({
        id: instanceId,
        package: id(item.package, `Plugin profile instances[${index}].package`),
        version: version(item.version, `Plugin profile instances[${index}].version`),
        enabled: item.enabled !== false,
        config: json(item.config),
        grants: grants(item.grants, `Plugin profile instances[${index}].grants`),
        policy: policy(item.policy, `Plugin profile instances[${index}].policy`)
      }));
    } catch (error) {
      // A row's position is a diagnostic locator, never a fabricated instance identity.
      const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      diagnostics.push(Object.freeze({ source: "profile", rowIndex: index,
        ...(identities[index] ? { instanceId: identities[index] } : {}),
        ...(typeof item.package === "string" ? { packageId: item.package } : {}),
        ...(typeof item.version === "string" ? { version: item.version } : {}),
        message: error instanceof Error ? error.message : String(error) }));
    }
  });
  return Object.freeze({ schemaVersion: 2, readyRequires: readyRequires(raw.readyRequires), instances: Object.freeze(instances),
    ...(diagnostics.length ? { diagnostics: Object.freeze(diagnostics) } : {}) });
}

export async function readPluginProfile(profilePath: string, options: Readonly<{ migrationsPath?: string }> = {}): Promise<PluginProfile> {
  const profileValue: unknown = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const profile = parsePluginProfile(profileValue);
  const migrationsPath = options.migrationsPath ?? path.join(path.dirname(profilePath), "package-migrations.json");
  let migrationText: string;
  try { migrationText = await fs.readFile(migrationsPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return profile; throw error; }
  let migrationValue: unknown;
  try { migrationValue = JSON.parse(migrationText); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("Plugin package migrations contain invalid JSON."); throw error; }
  const raw = record(migrationValue, "Plugin package migrations");
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) throw new Error("Unsupported plugin package migrations schema.");
  const diagnostics: PluginProfileDiagnostic[] = [...(profile.diagnostics ?? [])];
  const mappings = new Map<string, Set<string>>();
  raw.packages.forEach((value, rowIndex) => {
    try {
      const rule = record(value, `Plugin package migrations packages[${rowIndex}]`);
      const packageId = id(rule.packageId, "Plugin package migration packageId");
      const toVersion = version(rule.toVersion, "Plugin package migration toVersion");
      if (!Array.isArray(rule.fromVersions) || !rule.fromVersions.length) throw new Error("Plugin package migration fromVersions must be a nonempty array.");
      const fromVersions = rule.fromVersions.map(value => version(value, "Plugin package migration fromVersion"));
      for (const fromVersion of fromVersions) {
        const key = JSON.stringify([packageId, fromVersion]);
        const targets = mappings.get(key) ?? new Set<string>();
        targets.add(toVersion); mappings.set(key, targets);
      }
    } catch (error) {
      diagnostics.push(Object.freeze({ source: "package-migrations", rowIndex,
        message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const migrations: PluginProfileMigration[] = [];
  const instances = profile.instances.flatMap(instance => {
    const targets = mappings.get(JSON.stringify([instance.package, instance.version]));
    if (!targets) return [instance];
    if (targets.size > 1) {
      const rowIndex = (profileValue as { instances: Record<string, unknown>[] }).instances
        .findIndex(row => typeof row?.id === "string" && row.id.trim() === instance.id);
      diagnostics.push(Object.freeze({ source: "profile", rowIndex, instanceId: instance.id, packageId: instance.package,
        version: instance.version, message: `Conflicting package migrations for ${instance.package}@${instance.version}.` }));
      return [];
    }
    const toVersion = [...targets][0]!;
    if (toVersion === instance.version) return [instance];
    migrations.push(Object.freeze({ instanceId: instance.id, packageId: instance.package, fromVersion: instance.version, toVersion }));
    return [Object.freeze({ ...instance, version: toVersion })];
  });
  // Effective package references change only in memory. The profile owner retains its original file and business state.
  return Object.freeze({ ...profile, instances: Object.freeze(instances),
    ...(diagnostics.length ? { diagnostics: Object.freeze(diagnostics) } : {}),
    ...(migrations.length ? { migrations: Object.freeze(migrations) } : {}) });
}

export class PluginPackageCatalog {
  readonly #roots: readonly Readonly<{ path: string; inProcessTrusted: boolean }>[];
  readonly #restrictInProcess: boolean;
  readonly #loader: PluginPackageLoader;
  readonly #configurationDiagnostics: readonly PluginExecutionConfigurationDiagnostic[];
  constructor(
    roots: readonly string[],
    options: Readonly<{ trustedInProcessRoots?: readonly string[]; configurationDiagnostics?: readonly PluginExecutionConfigurationDiagnostic[]; loading?: PluginPackageLoadingOptions }> = {}
  ) {
    if (!roots.length) throw new Error("At least one plugin package root is required.");
    const trustedRoots = new Set((options.trustedInProcessRoots ?? roots).map(packageRootKey));
    const normalizedRoots = roots.map(root => path.resolve(root));
    const rootKeys = new Set(normalizedRoots.map(packageRootKey));
    const hasMatchingRoot = [...trustedRoots].some(root => rootKeys.has(root));
    this.#restrictInProcess = options.trustedInProcessRoots !== undefined && (trustedRoots.size === 0 || hasMatchingRoot);
    const diagnostics: PluginExecutionConfigurationDiagnostic[] = [...(options.configurationDiagnostics ?? [])];
    if ([...trustedRoots].some(root => !rootKeys.has(root))) {
      diagnostics.push(Object.freeze({ field: "RABIROUTE_PLUGIN_IN_PROCESS_ROOTS", message: "A configured in-process plugin root is not present in the package catalog. Change or clear RABIROUTE_PLUGIN_IN_PROCESS_ROOTS in the Manager startup environment (or trustedInProcessRoots in an embedded catalog). " + (hasMatchingRoot ? "Matching configured roots remain enabled." : "This invalid optional restriction was skipped; configured packages keep their declared execution modes.") }));
    }
    this.#configurationDiagnostics = Object.freeze(diagnostics);
    this.#roots = Object.freeze(normalizedRoots.map(root => Object.freeze({
      path: root,
      inProcessTrusted: !this.#restrictInProcess || trustedRoots.has(packageRootKey(root))
    })));
    this.#loader = new PluginPackageLoader(options.loading);
  }
  loadPackage(packageId: string, packageVersion: string, runtimeRoot: string, host: PluginHost): Promise<LoadedPluginPackage> {
    return this.#loader.load({ kind: "package", packageId, version: packageVersion, runtimeRoot: path.resolve(runtimeRoot), host, roots: this.#roots }) as Promise<LoadedPluginPackage>;
  }
  loadProfile(profilePath: string): Promise<PluginProfile> {
    return this.#loader.load({ kind: "profile", profilePath: path.resolve(profilePath) }) as Promise<PluginProfile>;
  }
  snapshot() { return Object.freeze({ ...this.#loader.snapshot(), configurationDiagnostics: this.#configurationDiagnostics }); }
  dispose(): Promise<void> { return this.#loader.dispose(); }
  async assertPackageExecutionAllowed(plugin: Pick<LoadedPluginPackage, "sourceRoot" | "execution">): Promise<void> {
    if (plugin.execution !== "in_process" || !this.#restrictInProcess) return;
    for (const root of this.#roots) {
      if (!root.inProcessTrusted) continue;
      let canonicalRoot: string;
      try { canonicalRoot = await fs.realpath(root.path); }
      catch (error) {
        // A removed ordinary root can still own a previously copied immutable
        // package. Existing junctions must use their current canonical target.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        canonicalRoot = root.path;
      }
      if (isInsidePackageRoot(packageRootKey(canonicalRoot), packageRootKey(plugin.sourceRoot))) return;
    }
    throw new Error(`Plugin in_process execution is disabled by the configured trustedInProcessRoots: ${JSON.stringify(this.#roots.filter(root => root.inProcessTrusted).map(root => root.path))}; sourceRoot=${plugin.sourceRoot}. Change or clear RABIROUTE_PLUGIN_IN_PROCESS_ROOTS in the Manager startup environment (or trustedInProcessRoots in an embedded catalog).`);
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
  loadFailures: readonly PluginProfileLoadFailure[];
  grants(identity: PluginIdentity): readonly string[];
}>;

export type PluginProfileLoadFailure = Readonly<{
  instanceId?: string;
  packageId?: string;
  version?: string;
  rowIndex?: number;
  source?: PluginProfileDiagnostic["source"];
  retainedRevision?: string;
  error: Readonly<{ code: "package_load_failed" | "profile_instance_invalid"; message: string }>;
}>;

export async function loadPluginProfile(input: Readonly<{
  profilePath: string;
  packageCatalog: PluginPackageCatalog;
  runtimeRoot: string;
  /** A host preparation failure retires this package/instance instead of retaining its previous candidate. */
  preparationFailure?: (packageId: string, instanceId?: string) => Error | undefined;
  host: PluginHost;
  /** Only successfully loaded immutable packages from the preceding reconciliation. */
  previous?: LoadedPluginProfile;
  /** Enable settings act on published immutable owners; source updates use ordinary loading. */
  reuseUnchangedPackages?: boolean;
  /** Effective profile from the single settings owner; avoids a second disk/config truth. */
  profile?: PluginProfile;
  /** The producer's original lifecycle; individual shared package jobs are not cancelled here. */
  assertCurrent?: () => void;
}>): Promise<LoadedPluginProfile> {
  let cancellation: Readonly<{ error: unknown }> | undefined;
  const assertCurrent = () => {
    if (cancellation) throw cancellation.error;
    try { input.assertCurrent?.(); }
    catch (error) { cancellation = { error }; throw error; }
  };
  assertCurrent();
  const profile = input.profile ?? await input.packageCatalog.loadProfile(input.profilePath);
  assertCurrent();
  const enabled = profile.instances.filter(instance => instance.enabled);
  const instancesByPackage = new Map<string, PluginProfileEntry[]>();
  for (const instance of enabled) {
    const key = JSON.stringify([instance.package, instance.version]);
    const instances = instancesByPackage.get(key) ?? [];
    instances.push(instance); instancesByPackage.set(key, instances);
  }
  const packages = [...instancesByPackage].map(([key, instances]) => [key, instances[0]!] as const);
  const reusable = new Map<string, LoadedPluginPackage>();
  if (input.reuseUnchangedPackages && input.previous) {
    const previousEntries = new Map(input.previous.packages.map(entry => [entry.instance.id, entry]));
    const previousCandidates = new Map(input.previous.candidates.map(candidate => [candidate.instanceId, candidate]));
    for (const [key, instances] of instancesByPackage) {
      let selected: LoadedPluginPackage | undefined;
      for (const instance of instances) {
        const entry = previousEntries.get(instance.id), candidate = previousCandidates.get(instance.id);
        if (!entry || !candidate || !isDeepStrictEqual(entry.instance, instance)
          || pluginPackageForCandidate(candidate) !== entry.package
          || selected && (selected.revision !== entry.package.revision || selected.runtimeRoot !== entry.package.runtimeRoot)) {
          selected = undefined; break;
        }
        selected = entry.package;
      }
      if (selected) reusable.set(key, selected);
    }
  }
  const reuseAdmissions = new Map<string, PromiseSettledResult<void>>();
  const packageResults = new Map<string, PromiseSettledResult<LoadedPluginPackage>>();
  const packagePreparationFailures = new Map<string, Error>();
  const preparationFailure = (packageId: string, instanceId?: string): Error | undefined => {
    try { return input.preparationFailure?.(packageId, instanceId); }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  };
  let next = 0;
  // Backpressure belongs to this batch producer. A large valid Profile must not
  // flood the catalog queue or give duplicate failing packages both producer lanes.
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(packages.length, input.packageCatalog.snapshot().maxConcurrency) }, async () => {
    while (next < packages.length) {
      assertCurrent();
      const [key, instance] = packages[next++]!;
      let result: PromiseSettledResult<LoadedPluginPackage>;
      const current = reusable.get(key);
      try {
        const failure = preparationFailure(instance.package);
        if (failure) { packagePreparationFailures.set(key, failure); throw failure; }
        if (current) {
          try {
            await input.packageCatalog.assertPackageExecutionAllowed(current);
            reuseAdmissions.set(key, { status: "fulfilled", value: undefined });
          } catch (reason) {
            reuseAdmissions.set(key, { status: "rejected", reason }); throw reason;
          }
        }
        result = { status: "fulfilled", value: current
          ?? await input.packageCatalog.loadPackage(instance.package, instance.version, input.runtimeRoot, input.host) };
      } catch (reason) { result = { status: "rejected", reason }; }
      // A lifecycle denial is not a bad package and must not enter fallback.
      assertCurrent();
      packageResults.set(key, result);
    }
  }));
  // All entered metadata I/O remains owned until every lane really settles.
  const failedLane = lanes.find(result => result.status === "rejected");
  if (failedLane?.status === "rejected") throw failedLane.reason;
  assertCurrent();
  const loaded: Array<Readonly<{ instance: PluginProfileEntry; package: LoadedPluginPackage; candidate: PluginCandidate }>> = [];
  const loadFailures: PluginProfileLoadFailure[] = (profile.diagnostics ?? []).map(({ message, ...diagnostic }) => Object.freeze({
    ...diagnostic, error: Object.freeze({ code: "profile_instance_invalid" as const, message })
  }));
  for (const instance of enabled) {
    assertCurrent();
    const packageKey = JSON.stringify([instance.package, instance.version]);
    const preparationError = packagePreparationFailures.get(packageKey) ?? preparationFailure(instance.package, instance.id);
    const result: PromiseSettledResult<LoadedPluginPackage> = preparationError ? { status: "rejected", reason: preparationError }
      : packageResults.get(packageKey)!;
    if (result.status === "fulfilled") {
      const plugin = result.value;
      const candidate: PluginCandidate = Object.freeze({
        instanceId: instance.id, revision: plugin.revision, manifest: plugin.manifest, config: instance.config,
        entry: Object.freeze({ execution: plugin.execution, path: plugin.entryPath }), policy: instance.policy
      });
      candidatePackages.set(candidate, plugin);
      loaded.push(Object.freeze({ instance, package: plugin, candidate }));
      continue;
    }
    const previousCandidate = input.previous?.candidates.find(candidate => candidate.instanceId === instance.id);
    const previousPackage = input.previous?.packages.find(item => item.instance.id === instance.id);
    // A failed update must not retire a previously verified package or apply the
    // failed revision's config, policy or grants to that old implementation.
    let retained = false;
    let failure = result.reason instanceof Error ? result.reason.message : String(result.reason);
    if (!preparationError && previousCandidate && previousPackage) {
      assertCurrent();
      let admission = reuseAdmissions.get(JSON.stringify([instance.package, instance.version]));
      if (!admission) {
        try {
          await input.packageCatalog.assertPackageExecutionAllowed(previousPackage.package);
          admission = { status: "fulfilled", value: undefined };
        } catch (reason) { admission = { status: "rejected", reason }; }
      }
      assertCurrent();
      if (admission.status === "fulfilled") {
        loaded.push(Object.freeze({ ...previousPackage, candidate: previousCandidate }));
        retained = true;
      } else {
        const error = admission.reason;
        failure += ` Previous revision was not retained: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    loadFailures.push(Object.freeze({
      instanceId: instance.id,
      packageId: instance.package,
      version: instance.version,
      ...(retained ? { retainedRevision: previousCandidate!.revision } : {}),
      error: Object.freeze({ code: "package_load_failed", message: failure })
    }));
  }
  assertCurrent();
  const grantsById = new Map(loaded.map(item => [item.instance.id, item.instance.grants]));
  return Object.freeze({
    profile,
    candidates: Object.freeze(loaded.map(item => item.candidate)),
    packages: Object.freeze(loaded.map(({ instance, package: pluginPackage }) => Object.freeze({ instance, package: pluginPackage }))),
    loadFailures: Object.freeze(loadFailures),
    grants(identity: Pick<PluginIdentity, "instanceId">): readonly string[] { return grantsById.get(identity.instanceId) ?? Object.freeze([]); }
  });
}


