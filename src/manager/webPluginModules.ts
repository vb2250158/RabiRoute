import fs from "node:fs/promises";
import path from "node:path";
import { materializeRabiPluginRevisionRoot } from "../runtime/pluginBundle.js";
import type { ManagerPluginReconciliationStatus } from "../runtime/managerPluginReconciler.js";
import type { LoadedManagerPluginPackage } from "./managerPluginPackageLoader.js";

export type WebPluginModule = Readonly<{
  id: string;
  instanceId: string;
  pluginId: string;
  version: string;
  rev: string;
}>;

type ResolvedWebPluginModule = WebPluginModule & Readonly<{ path: string }>;

const MAX_RETAINED_REVISIONS_PER_INSTANCE = 8;

function retainedModuleKey(id: string, rev: string): string {
  return `${id}\u0000${rev}`;
}

/**
 * Owns the browser module graph published by the successfully reconciled
 * Manager runtime. It never reads Profile files on API requests, so a bundle
 * that failed activation cannot be exposed to the browser.
 */
export class WebPluginModuleRegistry {
  private current = new Map<string, ResolvedWebPluginModule>();
  private readonly retained = new Map<string, ResolvedWebPluginModule>();
  private readonly retainedKeysByInstance = new Map<string, string[]>();

  constructor(private readonly runtimeRoot: string) {}

  list(): readonly WebPluginModule[] {
    return Object.freeze([...this.current.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ path: _path, ...module }) => Object.freeze(module)));
  }

  async updateFromReconciliation(
    loaded: readonly LoadedManagerPluginPackage<unknown>[],
    status: Pick<ManagerPluginReconciliationStatus, "state" | "active">
  ): Promise<void> {
    if (status.state !== "idle") return;
    const active = new Set(status.active);
    const next = new Map<string, ResolvedWebPluginModule>();
    for (const item of loaded) {
      if (!active.has(item.definition.instanceId)) continue;
      if (!item.bundle.manifest.hosts.includes("web") || !item.bundle.webEntryPath || !item.bundle.manifest.webEntry) continue;
      const revisionRoot = await materializeRabiPluginRevisionRoot(item.bundle, this.runtimeRoot);
      const module: ResolvedWebPluginModule = Object.freeze({
        id: item.definition.instanceId,
        instanceId: item.definition.instanceId,
        pluginId: item.bundle.manifest.id,
        version: item.bundle.manifest.version,
        rev: item.bundle.revision,
        path: path.join(revisionRoot, item.bundle.manifest.webEntry)
      });
      if (next.has(module.id)) throw new Error(`Duplicate active Web plugin module instance: ${module.id}.`);
      next.set(module.id, module);
      this.retain(module);
    }
    this.current = next;
  }

  async read(id: string, rev: string): Promise<Readonly<{ module: WebPluginModule; source: Buffer }>> {
    const current = this.current.get(id);
    const module = current?.rev === rev
      ? current
      : this.retained.get(retainedModuleKey(id, rev));
    if (!module) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    const { path: _path, ...publicModule } = module;
    return Object.freeze({
      module: Object.freeze(publicModule),
      source: await fs.readFile(module.path)
    });
  }

  private retain(module: ResolvedWebPluginModule): void {
    const key = retainedModuleKey(module.id, module.rev);
    this.retained.set(key, module);
    const history = this.retainedKeysByInstance.get(module.id) ?? [];
    const next = [key, ...history.filter(item => item !== key)];
    while (next.length > MAX_RETAINED_REVISIONS_PER_INSTANCE) {
      const expired = next.pop();
      if (expired) this.retained.delete(expired);
    }
    this.retainedKeysByInstance.set(module.id, next);
  }
}
