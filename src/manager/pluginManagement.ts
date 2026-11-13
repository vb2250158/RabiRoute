import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { parsePluginProfile, type PluginPackageCatalog } from "../plugin-kernel/profile.js";
import type { PluginPackageStore } from "./pluginPackageStore.js";
import type { PluginManifest } from "../plugin-kernel/types.js";
import type { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import type { PluginCatalogApiContext, PluginCatalogInvocation } from "./pluginCatalogRoutes.js";

/** Listing an inactive package needs its manifest, never executable package preparation. */
export async function readPluginManagementManifest(catalog: Pick<PluginPackageCatalog, "resolve">, packageId: string, version: string): Promise<PluginManifest> {
  const source = await catalog.resolve(packageId, version);
  const text = await fs.readFile(path.join(source.sourceRoot, "rabi.plugin.json"), "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Installed plugin manifest is invalid JSON.");
    throw error;
  }
  const manifest = parsePluginManifest(parsed);
  if (manifest.id !== packageId || manifest.version !== version) throw new Error("Installed plugin manifest identity does not match its configured instance.");
  return manifest;
}

export function createPluginManagement(options: {
  runtime: PluginCatalogApiContext["runtime"];
  settings: PluginProfileSettings;
  manifest(packageId: string, version: string): Promise<PluginManifest>;
  /** A committed settings change remains owned after the requesting HTTP client leaves. */
  reconcile(): Promise<void>;
  packages?: PluginPackageStore;
  packageSource?(packageId: string, version: string): Promise<string>;
  /** Schedules only actual presentation work, never joins plugin initialization. */
  changed?(): void;
}): NonNullable<PluginCatalogApiContext["management"]> {
  const list = async (invocation: PluginCatalogInvocation) => {
    invocation.assertCurrent();
    const snapshot = await options.settings.snapshot();
    invocation.assertCurrent();
    const initialRecords = new Map(options.runtime.current().records.map(record => [record.identity.instanceId, record]));
    const initialRetirements = options.runtime.pendingRetirements();
    const initialRetiringIds = new Set(initialRetirements.map(row => row.identity.instanceId));
    const instances = [...snapshot.profile.instances, ...snapshot.removedInstances.filter(instance =>
      initialRecords.has(instance.id) || initialRetiringIds.has(instance.id))];
    const installedIds = new Set(snapshot.profile.instances.map(instance => instance.id));
    const metadata: { manifest?: PluginManifest; error?: string }[] = new Array(instances.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, instances.length) }, async () => {
      while (next < instances.length) {
        const index = next++, instance = instances[index]!;
        const current = initialRecords.get(instance.id);
        if (current?.manifest.id === instance.package && current.manifest.version === instance.version) {
          metadata[index] = { manifest: current.manifest }; continue;
        }
        try { metadata[index] = { manifest: await options.manifest(instance.package, instance.version) }; }
        catch (error) { metadata[index] = { error: error instanceof Error ? error.message : String(error) }; }
      }
    }));
    invocation.assertCurrent();
    const generation = options.runtime.current();
    const records = new Map(generation.records.map(record => [record.identity.instanceId, record]));
    const retirements = options.runtime.pendingRetirements();
    const retiringById = new Map<string, (typeof retirements)[number][]>();
    for (const retirement of retirements) {
      const rows = retiringById.get(retirement.identity.instanceId) ?? [];
      rows.push(retirement); retiringById.set(retirement.identity.instanceId, rows);
    }
    const unconfirmed = new Map(generation.cleanupDiagnostics.filter(row => !row.lateConfirmed).map(row => [row.instanceId, row.message]));
    const settingErrors = new Map(snapshot.diagnostics.map(row => [row.instanceId, row.message]));
    return {
      applicationGenerationId: generation.applicationGenerationId,
      managerInstanceId: generation.managerInstanceId,
      revision: snapshot.revision,
      profileMigrations: snapshot.profile.migrations ?? [],
      profileDiagnostics: snapshot.profile.diagnostics ?? [],
      instances: instances.flatMap((instance, index) => {
        if (!installedIds.has(instance.id) && !records.has(instance.id) && !retiringById.has(instance.id)) return [];
        const active = records.get(instance.id), loaded = metadata[index]!;
        const retiring = retiringById.get(instance.id) ?? [];
        const retirementStatus = retiring.some(row => row.status === "retirement_unconfirmed") ? "retirement_unconfirmed" : retiring.length ? "stopping" : undefined;
        const failure = settingErrors.get(instance.id) ?? active?.error
          ?? (retirementStatus === "retirement_unconfirmed" ? unconfirmed.get(instance.id) : undefined) ?? loaded.error;
        const error = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : failure;
        return [{
          instanceId: instance.id, pluginId: instance.package, version: instance.version, enabled: installedIds.has(instance.id) && instance.enabled, installed: installedIds.has(instance.id),
          ...(active?.status === "active" && active.identity.pluginId === instance.package ? { runningVersion: active.identity.version } : {}),
          status: active?.status === "active" ? "active" : retirementStatus ?? active?.status ?? (settingErrors.has(instance.id) ? "settings_error" : !instance.enabled ? "disabled" : loaded.error ? "failed" : "inactive"),
          ...(retiring.length ? { retiringActivations: retiring } : {}),
          retirementDiagnostics: generation.cleanupDiagnostics.filter(row => row.instanceId === instance.id),
          ...(active?.initialization ? { initialization: active.initialization } : {}),
          missingCapabilities: active?.missingCapabilities ?? [],
          ...(loaded.manifest ? { manifest: loaded.manifest } : {}), ...(error ? { error } : {})
        }];
      })
    };
  };
  return {
    list,
    async packages(invocation) {
      invocation.assertCurrent();
      const [available, snapshot] = await Promise.all([options.packages?.listResult() ?? { packages: [], diagnostics: [], partial: false }, options.settings.snapshot()]);
      invocation.assertCurrent();
      return { packages: available.packages.map(item => ({ ...item, instanceIds: snapshot.profile.instances.filter(instance => instance.package === item.pluginId && instance.version === item.version).map(instance => instance.id) })), partial: available.partial, diagnostics: available.diagnostics };
    },
    async importPackage(sourceDirectory, invocation) {
      if (!options.packages) throw new Error("Local plugin package imports are unavailable.");
      const importedPackage = await options.packages.importDirectory(sourceDirectory, invocation.assertCurrent);
      return { ...await this.packages!(invocation) as Record<string, unknown>, importedPackage };
    },
    async install(input, invocation) {
      invocation.assertCurrent();
      const manifest = await options.manifest(input.pluginId, input.version);
      if (options.packages && options.packageSource) {
        await options.packages.importDirectory(await options.packageSource(manifest.id, manifest.version), invocation.assertCurrent, manifest);
      }
      const before = await options.settings.snapshot();
      const prior = input.instanceId
        ? [...before.profile.instances, ...before.removedInstances].find(instance => instance.id === input.instanceId)
        : before.removedInstances.find(instance => instance.package === manifest.id && instance.version === manifest.version);
      const instanceId = input.instanceId ?? prior?.id ?? `plugin:${randomUUID()}`;
      const definition = parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: [{
        ...(prior ?? {}), id: instanceId, package: manifest.id, version: manifest.version, enabled: true,
        config: prior?.config ?? {}, grants: prior?.grants ?? []
      }] }).instances[0];
      if (!definition) throw Object.assign(new Error("Plugin instance definition is invalid."), { status: 400 });
      await options.settings.install(definition, input.expectedRevision, invocation.assertCurrent);
      await options.reconcile();
      options.changed?.();
      invocation.assertCurrent();
      return list(invocation);
    },
    async uninstall(instanceId, expectedRevision, invocation) {
      await options.settings.uninstall(instanceId, expectedRevision, invocation.assertCurrent);
      // The original Kernel owns cancellation and late resources. Stored user data is retained.
      await options.reconcile();
      options.changed?.();
      invocation.assertCurrent();
      return list(invocation);
    },
    async update(instanceId, input, invocation) {
      await options.settings.update(instanceId, input, invocation.assertCurrent);
      await options.reconcile();
      options.changed?.();
      invocation.assertCurrent();
      return list(invocation);
    }
  };
}
