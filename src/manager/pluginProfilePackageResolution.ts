import type { LoadedPluginProfile, PluginPackageCatalog, PluginProfile } from "../plugin-kernel/profile.js";

/** Metadata follows the selected immutable package; disabled declarations remain discoverable. */
export function pluginProfilePackageResolution(desired: PluginProfile, loaded: LoadedPluginProfile,
  installed: Pick<PluginPackageCatalog, "resolve">): Readonly<{
    profile: PluginProfile; catalog: Pick<PluginPackageCatalog, "resolve">;
  }> {
  const byInstance = new Map(loaded.packages.map(entry => [entry.instance.id, entry]));
  const packages = new Map(loaded.packages.map(entry => [JSON.stringify([entry.instance.package, entry.instance.version]), entry.package]));
  return {
    profile: { ...desired, instances: desired.instances.map(instance => byInstance.get(instance.id)?.instance ?? instance) },
    catalog: {
      async resolve(packageId, version) {
        const selected = packages.get(JSON.stringify([packageId, version]));
        return selected ? { sourceRoot: selected.runtimeRoot, inProcessTrusted: selected.execution === "in_process" }
          : installed.resolve(packageId, version);
      }
    }
  };
}
