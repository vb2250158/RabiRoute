import fs from "node:fs/promises";
import path from "node:path";
import { rabiRoutePackageVersion } from "../packageInfo.js";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import type { DesiredManagerPlugin } from "../runtime/managerPluginReconciler.js";
import {
  loadManagerPluginProfile,
  type ManagerPluginPackageServiceFactory,
  type RabiManagerPluginPackageContext
} from "./managerPluginPackageLoader.js";
import {
  parseRabiPluginProfile,
  readRabiPluginProfile,
  type RabiPluginProfile,
  type RabiPluginProfileEntry
} from "./pluginProfile.js";

export const LEGACY_BUILTIN_MANAGER_PLUGIN_PACKAGE_ID = "rabi.manager.builtin";
export const BUILTIN_MANAGER_PLUGIN_PACKAGE_ID = "rabi.manager.base";
export const MANAGER_PLUGIN_PROFILE_RELATIVE_PATH = path.join("data", "plugins", "manager", "profile.json");
export const MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH = path.join("data", "plugins", "manager", "profile.d");
export const MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH = path.join("plugins", "packages");
export const MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH = path.join("data", "plugins", ".rabi-runtime");

export type ManagerPluginProfileDiagnostic = Readonly<{
  code: "core_cannot_disable" | "unknown_builtin_instance" | "builtin_package_identity_mismatch";
  instanceId: string;
  message: string;
}>;

export type BuiltinManagerPluginPackageServices<TServices> = TServices & Readonly<{
  createBuiltinManagerPluginDefinition(context: RabiManagerPluginPackageContext<BuiltinManagerPluginPackageServices<TServices>>): ManagerPluginDefinition;
}>;

export type ResolvedManagerPluginProfile<TServices> = Readonly<{
  profile: RabiPluginProfile;
  desired: readonly DesiredManagerPlugin[];
  diagnostics: readonly ManagerPluginProfileDiagnostic[];
  externalContexts: readonly RabiManagerPluginPackageContext<BuiltinManagerPluginPackageServices<TServices>>[];
}>;

export type ResolveManagerPluginProfileOptions<TServices> = Readonly<{
  rootDir: string;
  builtinDefinitions: readonly ManagerPluginDefinition[];
  createServices: ManagerPluginPackageServiceFactory<TServices>;
}>;

type LegacyManagerPluginEntry = Readonly<{ enabled?: unknown }>;

function builtinPackageId(instanceId: string): string {
  if (!instanceId.startsWith("manager:")) throw new Error(`Built-in Manager plugin instance id is invalid: ${instanceId}.`);
  return BUILTIN_MANAGER_PLUGIN_PACKAGE_ID;
}

function defaultProfile(definitions: readonly ManagerPluginDefinition[]): RabiPluginProfile {
  const version = rabiRoutePackageVersion();
  return parseRabiPluginProfile({
    schemaVersion: 1,
    plugins: definitions.map(definition => ({
      id: definition.instanceId,
      package: builtinPackageId(definition.instanceId),
      version,
      enabled: true,
      config: {}
    }))
  });
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

function migrateLegacyPackageRows(profile: RabiPluginProfile, definitions: readonly ManagerPluginDefinition[]): RabiPluginProfile {
  const known = new Set(definitions.map(definition => definition.instanceId));
  const plugins = profile.plugins.map(entry => {
    if (entry.package !== LEGACY_BUILTIN_MANAGER_PLUGIN_PACKAGE_ID) return entry;
    if (!known.has(entry.id)) return entry;
    return { ...entry, package: builtinPackageId(entry.id) };
  });
  return parseRabiPluginProfile({ schemaVersion: 1, plugins });
}

export async function migrateManagerPluginProfile(
  rootDir: string,
  definitions: readonly ManagerPluginDefinition[],
  legacyManagerPlugins?: unknown
): Promise<RabiPluginProfile> {
  const profilePath = path.join(rootDir, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
  try {
    const existing = await readRabiPluginProfile(profilePath);
    const migrated = migrateLegacyPackageRows(existing, definitions);
    if (migrated !== existing && JSON.stringify(migrated) !== JSON.stringify(existing)) {
      await writeJsonAtomically(profilePath, migrated);
    }
    return migrated;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const enabled = legacyEnabled(legacyManagerPlugins);
  const profile = defaultProfile(definitions);
  const migrated = parseRabiPluginProfile({
    schemaVersion: profile.schemaVersion,
    plugins: profile.plugins.map(entry => ({
      ...entry,
      enabled: entry.id === "manager:core" ? true : enabled.get(entry.id) ?? true
    }))
  });
  await writeJsonAtomically(profilePath, migrated);
  return migrated;
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

function packageDefinition(
  context: RabiManagerPluginPackageContext<unknown>,
  definition: ManagerPluginDefinition
): ManagerPluginDefinition {
  return {
    ...definition,
    manifest: {
      ...definition.manifest,
      id: context.bundle.id,
      version: context.bundle.version,
      kind: "package"
    }
  };
}

export async function resolveManagerPluginProfile<TServices>(
  options: ResolveManagerPluginProfileOptions<TServices>
): Promise<ResolvedManagerPluginProfile<TServices>> {
  const profilePath = path.join(options.rootDir, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
  const patchDirectory = path.join(options.rootDir, MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH);
  await migrateManagerPluginProfile(options.rootDir, options.builtinDefinitions);
  const diagnostics: ManagerPluginProfileDiagnostic[] = [];
  const profile = normalizeCore(await readRabiPluginProfile(profilePath, patchDirectory), diagnostics);
  const builtinById = new Map(options.builtinDefinitions.map(definition => [definition.instanceId, definition]));
  const createServices: ManagerPluginPackageServiceFactory<BuiltinManagerPluginPackageServices<TServices>> = identity => {
    const services = options.createServices(identity);
    return Object.freeze({
      ...services,
      createBuiltinManagerPluginDefinition(context) {
        const definition = builtinById.get(context.instanceId);
        if (!definition) throw new Error(`Unknown built-in Manager plugin instance: ${context.instanceId}.`);
        const expectedPackage = builtinPackageId(context.instanceId);
        if (context.bundle.id !== expectedPackage) {
          throw new Error(`Built-in Manager package identity mismatch: ${context.instanceId}.`);
        }
        return packageDefinition(context, definition);
      }
    });
  };
  const loaded = await loadManagerPluginProfile({
    packageRoot: path.join(options.rootDir, MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH),
    runtimeRoot: path.join(options.rootDir, MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH),
    profile,
    createServices
  });
  return Object.freeze({
    profile,
    desired: Object.freeze(loaded.map(item => item.desired)),
    diagnostics: Object.freeze(diagnostics),
    externalContexts: Object.freeze(loaded.map(item => item.context))
  });
}
