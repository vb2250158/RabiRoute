import path from "node:path";
import {
  importRabiPluginModule,
  loadRabiPluginBundle,
  type RabiPluginBundleManifest
} from "../runtime/pluginBundle.js";
import type { RabiCordisContext } from "../runtime/cordisHost.js";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import type { DesiredManagerPlugin } from "../runtime/managerPluginReconciler.js";
import {
  rabiPluginProfileEntryRevision,
  type RabiPluginProfile,
  type RabiPluginProfileEntry
} from "./pluginProfile.js";

export type RabiManagerPluginPackageContext<TServices> = Readonly<{
  instanceId: string;
  config: unknown;
  bundle: Readonly<{
    id: string;
    version: string;
    revision: string;
  }>;
  services: TServices;
}>;

export type RabiManagerPluginPackageModule<TServices> = Readonly<{
  createPlugin?: (context: RabiManagerPluginPackageContext<TServices>) => ManagerPluginDefinition | Promise<ManagerPluginDefinition>;
}>;

export type ManagerPluginPackageServiceFactory<TServices> = (
  context: Readonly<{
    instanceId: string;
    config: unknown;
    bundle: Readonly<{ id: string; version: string; revision: string }>;
  }>
) => TServices;

export type ManagerPluginPackageLoaderOptions<TServices> = Readonly<{
  packageRoot: string;
  runtimeRoot: string;
  profile: RabiPluginProfile;
  createServices: ManagerPluginPackageServiceFactory<TServices>;
}>;

export type LoadedManagerPluginPackage<TServices> = Readonly<{
  profile: RabiPluginProfileEntry;
  definition: ManagerPluginDefinition;
  bundle: RabiPluginBundleManifest;
  context: RabiManagerPluginPackageContext<TServices>;
  desired: DesiredManagerPlugin;
}>;

type StopOnDisposeService = Readonly<{ stop?: () => Promise<void> | void }>;

function packageDirectory(id: string): string {
  return encodeURIComponent(id);
}

function bundleDirectory(packageRoot: string, entry: RabiPluginProfileEntry): string {
  return path.join(path.resolve(packageRoot), packageDirectory(entry.package), entry.version);
}

function verifyDefinition(
  entry: RabiPluginProfileEntry,
  bundle: RabiPluginBundleManifest,
  definition: ManagerPluginDefinition
): ManagerPluginDefinition {
  if (!definition || typeof definition !== "object") throw new Error(`Plugin package did not return a definition: ${entry.id}.`);
  if (definition.instanceId !== entry.id) throw new Error(`Plugin package instance id mismatch: ${entry.id}.`);
  if (definition.manifest?.id !== bundle.id || definition.manifest?.version !== bundle.version) {
    throw new Error(`Plugin package manifest mismatch: ${entry.id}.`);
  }
  if (definition.manifest.kind !== "package" || !definition.manifest.hosts.includes("manager")) {
    throw new Error(`Plugin package is not a Manager package: ${entry.id}.`);
  }
  if (definition.scope !== undefined && definition.scope !== "global") {
    throw new Error(`Plugin package scope is unsupported: ${entry.id}.`);
  }
  return definition;
}

function bindServiceDisposal<TServices>(
  definition: ManagerPluginDefinition,
  services: TServices
): ManagerPluginDefinition {
  const service = services as StopOnDisposeService;
  if (typeof service.stop !== "function") return definition;
  const apply = definition.apply;
  return {
    ...definition,
    async apply(ctx: RabiCordisContext): Promise<void> {
      ctx.effect(() => () => service.stop!(), `stop package host ${definition.instanceId}`);
      await apply?.(ctx);
    }
  };
}

async function loadOne<TServices>(
  entry: RabiPluginProfileEntry,
  options: ManagerPluginPackageLoaderOptions<TServices>
): Promise<LoadedManagerPluginPackage<TServices>> {
  const bundle = await loadRabiPluginBundle(bundleDirectory(options.packageRoot, entry));
  if (!bundle.manifest.hosts.includes("manager")) throw new Error(`Plugin package does not support Manager: ${entry.package}.`);
  if (bundle.manifest.id !== entry.package || bundle.manifest.version !== entry.version) {
    throw new Error(`Plugin profile package/version does not match bundle manifest: ${entry.id}.`);
  }
  const identity = Object.freeze({
    instanceId: entry.id,
    config: entry.config,
    bundle: Object.freeze({ id: bundle.manifest.id, version: bundle.manifest.version, revision: bundle.revision })
  });
  const services = options.createServices(identity);
  const context: RabiManagerPluginPackageContext<TServices> = Object.freeze({ ...identity, services });
  const module = await importRabiPluginModule(bundle, options.runtimeRoot) as RabiManagerPluginPackageModule<TServices>;
  if (typeof module.createPlugin !== "function") throw new Error(`Plugin package entry does not export createPlugin(): ${entry.id}.`);
  const definition = bindServiceDisposal(verifyDefinition(entry, bundle.manifest, await module.createPlugin(context)), services);
  return Object.freeze({
    profile: entry,
    definition,
    bundle: bundle.manifest,
    context,
    desired: Object.freeze({
      definition,
      enabled: entry.enabled,
      revision: rabiPluginProfileEntryRevision(entry, bundle.revision)
    })
  });
}

export async function loadManagerPluginProfile<TServices>(
  options: ManagerPluginPackageLoaderOptions<TServices>
): Promise<readonly LoadedManagerPluginPackage<TServices>[]> {
  const loaded = await Promise.all(options.profile.plugins.map(entry => loadOne(entry, options)));
  return Object.freeze(loaded);
}