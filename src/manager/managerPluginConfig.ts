import fs from "node:fs/promises";
import path from "node:path";
import { rabiRoutePackageVersion } from "../packageInfo.js";
import { loadRabiPluginBundle } from "../runtime/pluginBundle.js";
import type { DesiredManagerPlugin } from "../runtime/managerPluginReconciler.js";
import {
  loadManagerPluginProfile,
  type LoadedManagerPluginPackage,
  type ManagerPluginPackageServiceFactory
} from "./managerPluginPackageLoader.js";
import {
  parseRabiPluginProfile,
  parseRabiPluginProfilePatch,
  readRabiPluginProfile,
  type RabiPluginProfile,
  type RabiPluginProfilePatch
} from "./pluginProfile.js";

/** Input-only compatibility name. It is rewritten during post-listener profile initialization. */
export const LEGACY_BUILTIN_MANAGER_PLUGIN_PACKAGE_ID = "rabi.manager.builtin";
export const BUILTIN_MANAGER_PLUGIN_PACKAGE_ID = "rabi.manager.base";
export const MANAGER_PLUGIN_PROFILE_RELATIVE_PATH = path.join("data", "plugins", "manager", "profile.json");
export const MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH = path.join("data", "plugins", "manager", "profile.d");
export const MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH = path.join("plugins", "packages");
export const MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH = path.join("data", "plugins", ".rabi-runtime");
export const MANAGER_BASE_DEFAULT_PROFILE_FILE = "rabi.manager.profile.json";

export type ManagerPluginProfileDiagnostic = Readonly<{
  code: "core_cannot_disable";
  instanceId: string;
  message: string;
}>;

export type ResolvedManagerPluginProfile<TServices> = Readonly<{
  profile: RabiPluginProfile;
  desired: readonly DesiredManagerPlugin[];
  diagnostics: readonly ManagerPluginProfileDiagnostic[];
  loaded: readonly LoadedManagerPluginPackage<TServices>[];
}>;

export type ResolveManagerPluginProfileOptions<TServices> = Readonly<{
  rootDir: string;
  /** Startup-only read of manager.json.managerPlugins, never persisted or used after the listener is ready. */
  bootstrapLegacyManagerPlugins?: unknown;
  createServices: ManagerPluginPackageServiceFactory<TServices>;
}>;

export type ManagerPluginProfileInitialization = Readonly<{
  profile: RabiPluginProfile;
  /** True only when the post-listener compatibility initializer rewrote a Profile or Patch file. */
  wroteConfiguration: boolean;
}>;

type LegacyManagerPluginEntry = Readonly<{ enabled?: unknown }>;

function packageDirectory(id: string): string {
  return encodeURIComponent(id);
}

function profilePath(rootDir: string): string {
  return path.join(rootDir, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
}

function packageRoot(rootDir: string): string {
  return path.join(rootDir, MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function legacyEnabled(raw: unknown): Map<string, boolean> {
  const enabled = new Map<string, boolean>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return enabled;
  for (const [instanceId, entry] of Object.entries(raw as Record<string, LegacyManagerPluginEntry>)) {
    if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") enabled.set(instanceId, entry.enabled);
  }
  return enabled;
}

async function bundledDefaultProfile(rootDir: string): Promise<RabiPluginProfile> {
  const packageVersion = rabiRoutePackageVersion();
  const bundle = await loadRabiPluginBundle(path.join(
    packageRoot(rootDir),
    packageDirectory(BUILTIN_MANAGER_PLUGIN_PACKAGE_ID),
    packageVersion
  ));
  if (bundle.manifest.id !== BUILTIN_MANAGER_PLUGIN_PACKAGE_ID || bundle.manifest.version !== packageVersion) {
    throw new Error("The shipped rabi.manager.base Bundle identity does not match the RabiRoute package version.");
  }
  const profile = parseRabiPluginProfile(JSON.parse(await fs.readFile(
    path.join(bundle.rootDir, MANAGER_BASE_DEFAULT_PROFILE_FILE),
    "utf8"
  )) as unknown);
  if (!profile.plugins.length || !profile.plugins.some(entry => entry.id === "manager:core")) {
    throw new Error("The shipped rabi.manager.base Bundle default profile must include manager:core.");
  }
  for (const entry of profile.plugins) {
    if (entry.package !== bundle.manifest.id || entry.version !== bundle.manifest.version) {
      throw new Error(`The shipped rabi.manager.base default profile has an invalid package row: ${entry.id}.`);
    }
  }
  return profile;
}

function migrateLegacyPackageEntry(
  entry: RabiPluginProfile["plugins"][number],
  bundledByInstanceId: ReadonlyMap<string, RabiPluginProfile["plugins"][number]>
): RabiPluginProfile["plugins"][number] {
  if (entry.package !== LEGACY_BUILTIN_MANAGER_PLUGIN_PACKAGE_ID) return entry;
  const bundled = bundledByInstanceId.get(entry.id);
  if (!bundled) return entry;
  return { ...entry, package: BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, version: bundled.version };
}

function migrateLegacyPackageRows(profile: RabiPluginProfile, bundledProfile: RabiPluginProfile): RabiPluginProfile {
  const bundledByInstanceId = new Map(bundledProfile.plugins.map(entry => [entry.id, entry]));
  return parseRabiPluginProfile({
    schemaVersion: 1,
    plugins: profile.plugins.map(entry => migrateLegacyPackageEntry(entry, bundledByInstanceId))
  });
}

function migrateLegacyPackagePatchRows(
  patch: RabiPluginProfilePatch,
  bundledProfile: RabiPluginProfile
): RabiPluginProfilePatch {
  const bundledByInstanceId = new Map(bundledProfile.plugins.map(entry => [entry.id, entry]));
  return parseRabiPluginProfilePatch({
    schemaVersion: 1,
    operations: patch.operations.map(operation => operation.op === "upsert"
      ? { ...operation, plugin: migrateLegacyPackageEntry(operation.plugin, bundledByInstanceId) }
      : operation)
  });
}

async function migrateLegacyPackagePatches(rootDir: string, bundledProfile: RabiPluginProfile): Promise<boolean> {
  const directory = path.join(rootDir, MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  let wroteConfiguration = false;
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    const existing = parseRabiPluginProfilePatch(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
    const migrated = migrateLegacyPackagePatchRows(existing, bundledProfile);
    if (JSON.stringify(existing) === JSON.stringify(migrated)) continue;
    await writeJsonAtomically(filePath, migrated);
    wroteConfiguration = true;
  }
  return wroteConfiguration;
}

function initialProfile(bundledProfile: RabiPluginProfile, legacyManagerPlugins?: unknown): RabiPluginProfile {
  const enabled = legacyEnabled(legacyManagerPlugins);
  return parseRabiPluginProfile({
    schemaVersion: bundledProfile.schemaVersion,
    plugins: bundledProfile.plugins.map(entry => ({
      ...entry,
      enabled: entry.id === "manager:core" ? true : enabled.get(entry.id) ?? entry.enabled
    }))
  });
}

/**
 * Writes the Profile once after the Manager listener is available. Compatibility
 * data is consumed here only; normal reconciliation never reads manager.json.managerPlugins.
 */
export async function initializeManagerPluginProfile(
  rootDir: string,
  legacyManagerPlugins?: unknown
): Promise<ManagerPluginProfileInitialization> {
  const defaults = await bundledDefaultProfile(rootDir);
  try {
    const existing = await readRabiPluginProfile(profilePath(rootDir));
    const migrated = migrateLegacyPackageRows(existing, defaults);
    const wroteProfile = JSON.stringify(existing) !== JSON.stringify(migrated);
    if (wroteProfile) await writeJsonAtomically(profilePath(rootDir), migrated);
    const wrotePatches = await migrateLegacyPackagePatches(rootDir, defaults);
    return Object.freeze({ profile: migrated, wroteConfiguration: wroteProfile || wrotePatches });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const profile = initialProfile(defaults, legacyManagerPlugins);
  await writeJsonAtomically(profilePath(rootDir), profile);
  await migrateLegacyPackagePatches(rootDir, defaults);
  return Object.freeze({ profile, wroteConfiguration: true });
}

async function readProfileForReconciliation(
  rootDir: string,
  bootstrapLegacyManagerPlugins?: unknown
): Promise<RabiPluginProfile> {
  try {
    const profile = await readRabiPluginProfile(
      profilePath(rootDir),
      path.join(rootDir, MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH)
    );
    // A deployed pre-0.2.1 Profile can name the retired package. Convert it in
    // memory for the first load; post-listener initialization persists the same
    // conversion before normal watcher-driven reconciliation begins.
    return migrateLegacyPackageRows(profile, await bundledDefaultProfile(rootDir));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // First listener bootstrap uses the shipped default in memory. Persistence is
    // deliberately deferred to initializeManagerPluginProfile() after listening.
    return initialProfile(await bundledDefaultProfile(rootDir), bootstrapLegacyManagerPlugins);
  }
}

function normalizeCore(profile: RabiPluginProfile, diagnostics: ManagerPluginProfileDiagnostic[]): RabiPluginProfile {
  return parseRabiPluginProfile({
    schemaVersion: 1,
    plugins: profile.plugins.map(entry => {
      if (entry.id !== "manager:core" || entry.enabled) return entry;
      diagnostics.push({
        code: "core_cannot_disable",
        instanceId: entry.id,
        message: "Required Manager plugin cannot be disabled: manager:core"
      });
      return { ...entry, enabled: true };
    })
  });
}

export async function resolveManagerPluginProfile<TServices>(
  options: ResolveManagerPluginProfileOptions<TServices>
): Promise<ResolvedManagerPluginProfile<TServices>> {
  const diagnostics: ManagerPluginProfileDiagnostic[] = [];
  const profile = normalizeCore(
    await readProfileForReconciliation(options.rootDir, options.bootstrapLegacyManagerPlugins),
    diagnostics
  );
  const loaded = await loadManagerPluginProfile({
    packageRoot: packageRoot(options.rootDir),
    runtimeRoot: path.join(options.rootDir, MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH),
    profile,
    createServices: options.createServices
  });
  return Object.freeze({
    profile,
    desired: Object.freeze(loaded.map(item => item.desired)),
    diagnostics: Object.freeze(diagnostics),
    loaded: Object.freeze(loaded)
  });
}
