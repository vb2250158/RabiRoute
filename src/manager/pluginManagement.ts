import fs from "node:fs/promises";
import path from "node:path";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginPackageCatalog } from "../plugin-kernel/profile.js";
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
}): NonNullable<PluginCatalogApiContext["management"]> {
  const list = async (invocation: PluginCatalogInvocation) => {
    invocation.assertCurrent();
    const snapshot = await options.settings.snapshot();
    invocation.assertCurrent();
    const initialRecords = new Map(options.runtime.current().records.map(record => [record.identity.instanceId, record]));
    const metadata: { manifest?: PluginManifest; error?: string }[] = new Array(snapshot.profile.instances.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, snapshot.profile.instances.length) }, async () => {
      while (next < snapshot.profile.instances.length) {
        const index = next++, instance = snapshot.profile.instances[index]!;
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
    const unconfirmed = new Map(generation.cleanupDiagnostics.filter(row => !row.lateConfirmed).map(row => [row.instanceId, row.message]));
    const settingErrors = new Map(snapshot.diagnostics.map(row => [row.instanceId, row.message]));
    return {
      applicationGenerationId: generation.applicationGenerationId,
      managerInstanceId: generation.managerInstanceId,
      revision: snapshot.revision,
      instances: snapshot.profile.instances.map((instance, index) => {
        const active = records.get(instance.id), loaded = metadata[index]!;
        const failure = settingErrors.get(instance.id) ?? active?.error ?? unconfirmed.get(instance.id) ?? loaded.error;
        const error = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : failure;
        return {
          instanceId: instance.id, pluginId: instance.package, version: instance.version, enabled: instance.enabled,
          ...(active?.status === "active" && active.identity.pluginId === instance.package ? { runningVersion: active.identity.version } : {}),
          status: active?.status ?? (unconfirmed.has(instance.id) ? "retirement_unconfirmed" : settingErrors.has(instance.id) ? "settings_error" : !instance.enabled ? "disabled" : loaded.error ? "failed" : "inactive"),
          missingCapabilities: active?.missingCapabilities ?? [],
          ...(loaded.manifest ? { manifest: loaded.manifest } : {}), ...(error ? { error } : {})
        };
      })
    };
  };
  return {
    list,
    async update(instanceId, input, invocation) {
      await options.settings.update(instanceId, input, invocation.assertCurrent);
      await options.reconcile();
      invocation.assertCurrent();
      return list(invocation);
    }
  };
}
