import type { PluginManifest, PluginProfile } from "../plugin-kernel/index.js";
import { gatewayEndpointTypesFromManifests } from "../shared/messageEndpointTypes.js";

/** Installed host declarations are independent of desired enablement and current activation. */
export async function readInstalledGatewayEndpointTypes(profile: PluginProfile,
  readManifest: (packageId: string, version: string) => Promise<PluginManifest>): Promise<Readonly<{
    types: ReadonlySet<string>; diagnostics: readonly Readonly<{instanceId: string; message: string}>[];
  }>> {
  const reads = new Map<string, Promise<PluginManifest>>();
  for (const instance of profile.instances) {
    const key = JSON.stringify([instance.package, instance.version]);
    if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => readManifest(instance.package, instance.version)));
  }
  const results = await Promise.allSettled(profile.instances.map(instance => reads.get(JSON.stringify([instance.package, instance.version]))!));
  const manifests: PluginManifest[] = [], diagnostics: Array<{instanceId: string; message: string}> = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") manifests.push(result.value);
    else diagnostics.push({instanceId: profile.instances[index]!.id, message: result.reason instanceof Error ? result.reason.message : String(result.reason)});
  });
  return Object.freeze({types: gatewayEndpointTypesFromManifests(manifests), diagnostics: Object.freeze(diagnostics)});
}
