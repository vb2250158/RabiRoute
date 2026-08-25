import fs from "node:fs/promises";
import path from "node:path";
import { loadRabiPluginBundle, materializeRabiPluginRevisionRoot } from "../runtime/pluginBundle.js";
import {
  MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH,
  MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH,
  MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH,
  MANAGER_PLUGIN_PROFILE_RELATIVE_PATH
} from "./managerPluginConfig.js";
import { readRabiPluginProfile } from "./pluginProfile.js";

export type WebPluginModule = Readonly<{
  id: string;
  instanceId: string;
  pluginId: string;
  version: string;
  rev: string;
}>;

type ResolvedWebPluginModule = WebPluginModule & Readonly<{ path: string }>;

const retainedModules = new Map<string, ResolvedWebPluginModule>();
const retainedModuleKeysByInstance = new Map<string, string[]>();
const MAX_RETAINED_REVISIONS_PER_INSTANCE = 8;

function packageDirectory(id: string): string {
  return encodeURIComponent(id);
}

function retainedModuleKey(rootDir: string, id: string, rev: string): string {
  return `${path.resolve(rootDir)}\u0000${id}\u0000${rev}`;
}

function retainModule(rootDir: string, module: ResolvedWebPluginModule): void {
  const key = retainedModuleKey(rootDir, module.id, module.rev);
  retainedModules.set(key, module);
  const instanceKey = `${path.resolve(rootDir)}\u0000${module.id}`;
  const history = retainedModuleKeysByInstance.get(instanceKey) ?? [];
  const next = [key, ...history.filter(item => item !== key)];
  while (next.length > MAX_RETAINED_REVISIONS_PER_INSTANCE) {
    const expired = next.pop();
    if (expired) retainedModules.delete(expired);
  }
  retainedModuleKeysByInstance.set(instanceKey, next);
}

export async function readWebPluginModules(rootDir: string): Promise<readonly ResolvedWebPluginModule[]> {
  const profile = await readRabiPluginProfile(
    path.join(rootDir, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH),
    path.join(rootDir, MANAGER_PLUGIN_PROFILE_PATCH_RELATIVE_PATH)
  );
  const modules = await Promise.all(profile.plugins
    .filter(entry => entry.enabled)
    .map(async entry => {
      const bundle = await loadRabiPluginBundle(path.join(rootDir, MANAGER_PLUGIN_PACKAGE_RELATIVE_PATH, packageDirectory(entry.package), entry.version));
      if (!bundle.manifest.hosts.includes("web") || !bundle.webEntryPath || !bundle.manifest.webEntry) return undefined;
      const revisionRoot = await materializeRabiPluginRevisionRoot(
        bundle,
        path.join(rootDir, MANAGER_PLUGIN_RUNTIME_RELATIVE_PATH)
      );
      return Object.freeze({
        id: entry.id,
        instanceId: entry.id,
        pluginId: bundle.manifest.id,
        version: bundle.manifest.version,
        rev: bundle.revision,
        path: path.join(revisionRoot, bundle.manifest.webEntry)
      });
    }));
  const resolved = modules.filter((item): item is ResolvedWebPluginModule => Boolean(item));
  if (new Set(resolved.map(item => item.id)).size !== resolved.length) throw new Error("Duplicate active Web plugin module instance.");
  for (const module of resolved) retainModule(rootDir, module);
  return Object.freeze(resolved.sort((left, right) => left.id.localeCompare(right.id)));
}

export async function readWebPluginModuleSource(
  rootDir: string,
  id: string,
  rev: string
): Promise<Readonly<{ module: WebPluginModule; source: Buffer }>> {
  const current = await readWebPluginModules(rootDir);
  const module = current.find(item => item.id === id && item.rev === rev)
    ?? retainedModules.get(retainedModuleKey(rootDir, id, rev));
  if (!module) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
  return Object.freeze({
    module,
    source: await fs.readFile(module.path)
  });
}
