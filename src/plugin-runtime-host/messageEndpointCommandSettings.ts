import fs from "node:fs/promises";
import path from "node:path";
import { PluginPackageCatalog } from "../plugin-kernel/profile.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { PluginProfileSettings } from "./profileSettings.js";
import { isolateCapabilityGraph } from "../plugin-kernel/capabilityGraphIsolation.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";
import { getTimeoutMs } from "../plugin-kernel/runtimeTimeouts.js";

type ManagerAdmission = Readonly<{ baseUrl: string; applicationGenerationId?: string; managerInstanceId?: string; accessToken?: string }>;

async function managerEndpointActive(type: string, instanceId: string | undefined, manager: ManagerAdmission): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/plugins/instances", manager.baseUrl), {
      headers: manager.accessToken ? { authorization: `Bearer ${manager.accessToken}` } : {},
      signal: AbortSignal.timeout(getTimeoutMs("backend.plugin-runtime-host.messageEndpointCommandSettings.snapshot", 15_000))
    });
    if (!response.ok) return false;
    const body = await response.json() as { code?: number; data?: { applicationGenerationId?: string; managerInstanceId?: string; instances?: unknown } };
    const snapshot = body.data;
    if (body.code !== 0 || !snapshot || !Array.isArray(snapshot.instances)) return false;
    if (manager.applicationGenerationId && snapshot.applicationGenerationId !== manager.applicationGenerationId) return false;
    if (manager.managerInstanceId && snapshot.managerInstanceId !== manager.managerInstanceId) return false;
    return snapshot.instances.some((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const instance = row as { instanceId?: string; pluginId?: string; version?: string; status?: string; manifest?: unknown };
      if (instanceId && instance.instanceId !== instanceId || instance.status !== "active") return false;
      try {
        const manifest = parsePluginManifest(instance.manifest);
        return manifest.id === instance.pluginId && manifest.version === instance.version && manifest.provides.includes(`endpoint.${type}@1`);
      } catch { return false; }
    });
  } catch { return false; }
}

/** Short-lived CLI entrances consult the same durable owner as the running Manager and Gateway. */
export async function messageEndpointCommandEnabled(type: string, options: {
  profilePath: string; settingsRoot: string; packageRoots: readonly string[]; instanceId?: string; manager?: ManagerAdmission;
}): Promise<boolean> {
  // A Manager-launched command must use its actual publication, including dependency failures.
  if (options.manager) return managerEndpointActive(type, options.instanceId, options.manager);
  const snapshot = await new PluginProfileSettings(options).snapshot();
  const catalog = new PluginPackageCatalog(options.packageRoots);
  const candidates: PluginCandidate[] = [];
  const hostCapabilities = new Set<string>();
  const invalidSettings = new Set(snapshot.diagnostics.map(row => row.instanceId));
  try {
    for (const instance of snapshot.profile.instances) {
      if (!instance.enabled || invalidSettings.has(instance.id)) continue;
      try {
        const source = await catalog.resolve(instance.package, instance.version);
        const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(source.sourceRoot, "rabi.plugin.json"), "utf8")));
        if (manifest.id !== instance.package || manifest.version !== instance.version) continue;
        const entry = manifest.entries.manager ?? manifest.entries.gateway;
        if (!entry || entry.execution === "declarative") continue;
        candidates.push({ instanceId: instance.id, revision: instance.version, manifest, config: instance.config,
          entry: { execution: entry.execution, path: path.join(source.sourceRoot, entry.module) } });
        // Offline CLI checks declared plugin dependencies; it does not claim a running Host.
        for (const capability of manifest.requires) if (capability.startsWith("host.")) hostCapabilities.add(capability);
      } catch {
        // A bad optional package cannot authorize this entrance or reject an independent package.
      }
    }
    const available = new Set(isolateCapabilityGraph(candidates, hostCapabilities).plan.activationOrder);
    return candidates.some(candidate => (!options.instanceId || candidate.instanceId === options.instanceId)
      && available.has(candidate.instanceId) && candidate.manifest.provides.includes(`endpoint.${type}@1`));
  } finally { await catalog.dispose(); }
}
