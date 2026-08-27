import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { materializeRabiPluginRevisionRoot } from "../runtime/pluginBundle.js";
import type { ManagerPluginReconciliationStatus } from "../runtime/managerPluginReconciler.js";
import type { LoadedManagerPluginPackage } from "./managerPluginPackageLoader.js";

export type WebPluginModuleInstance = Readonly<{
  instanceId: string;
}>;

export type WebPluginModule = Readonly<{
  /** Stable Bundle package identity. It deliberately does not include rev. */
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  /** Active Manager instances served by this one browser Bundle load. */
  instances: readonly WebPluginModuleInstance[];
}>;

type ResolvedWebPluginModule = WebPluginModule & Readonly<{ rootPath: string }>;
type PendingWebPluginModule = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  bundle: LoadedManagerPluginPackage<unknown>["bundle"];
  instances: readonly WebPluginModuleInstance[];
}>;

const MAX_RETAINED_REVISIONS_PER_MODULE = 8;

function retainedModuleKey(id: string, rev: string): string { return `${id}\u0000${rev}`; }

function webModuleId(pluginId: string, version: string): string {
  return `web-${createHash("sha256").update(`${pluginId}\u0000${version}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw Object.assign(new Error("Web plugin module path is invalid."), { code: "ENOENT" });
  }
  return normalized;
}

/** The browser graph is a snapshot of successfully reconciled Bundle revisions. */
export class WebPluginModuleRegistry {
  private current = new Map<string, ResolvedWebPluginModule>();
  private readonly retained = new Map<string, ResolvedWebPluginModule>();
  private readonly retainedKeysByModule = new Map<string, string[]>();

  constructor(private readonly runtimeRoot: string) {}

  list(): readonly WebPluginModule[] {
    return Object.freeze([...this.current.values()].sort((left, right) => left.id.localeCompare(right.id))
      .map(({ rootPath: _rootPath, ...module }) => Object.freeze(module)));
  }

  async updateFromReconciliation(
    loaded: readonly LoadedManagerPluginPackage<unknown>[],
    status: Pick<ManagerPluginReconciliationStatus, "state" | "active">
  ): Promise<void> {
    if (status.state !== "idle") return;
    const active = new Set(status.active);
    const pending = new Map<string, {
      id: string;
      pluginId: string;
      version: string;
      rev: string;
      entryPath: string;
      bundle: LoadedManagerPluginPackage<unknown>["bundle"];
      instances: WebPluginModuleInstance[];
    }>();

    for (const item of loaded) {
      if (!active.has(item.definition.instanceId)) continue;
      if (!item.bundle.manifest.hosts.includes("web") || !item.bundle.webEntryPath || !item.bundle.manifest.webEntry) continue;
      const pluginId = item.bundle.manifest.id;
      const version = item.bundle.manifest.version;
      const entryPath = safeRelativePath(item.bundle.manifest.webEntry);
      const id = webModuleId(pluginId, version);
      const existing = pending.get(id);
      if (existing) {
        if (existing.rev !== item.bundle.revision || existing.entryPath !== entryPath) {
          throw new Error(`Active Web Bundle package has inconsistent revision or entry: ${pluginId}@${version}.`);
        }
        existing.instances.push(Object.freeze({ instanceId: item.definition.instanceId }));
        continue;
      }
      pending.set(id, {
        id,
        pluginId,
        version,
        rev: item.bundle.revision,
        entryPath,
        bundle: item.bundle,
        instances: [Object.freeze({ instanceId: item.definition.instanceId })]
      });
    }

    const next = new Map<string, ResolvedWebPluginModule>();
    for (const group of pending.values()) {
      const rootPath = await materializeRabiPluginRevisionRoot(group.bundle, this.runtimeRoot);
      const module: ResolvedWebPluginModule = Object.freeze({
        id: group.id,
        pluginId: group.pluginId,
        version: group.version,
        rev: group.rev,
        entryPath: group.entryPath,
        instances: Object.freeze([...group.instances].sort((left, right) => left.instanceId.localeCompare(right.instanceId))),
        rootPath
      });
      next.set(module.id, module);
      this.retain(module);
    }
    this.current = next;
  }

  async read(id: string, rev: string, relativePath: string): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string }>> {
    const current = this.current.get(id);
    const module = current?.rev === rev ? current : this.retained.get(retainedModuleKey(id, rev));
    if (!module) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    const safePath = safeRelativePath(relativePath);
    const sourcePath = path.resolve(module.rootPath, safePath);
    const relative = path.relative(module.rootPath, sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    const { rootPath: _rootPath, ...publicModule } = module;
    return Object.freeze({ module: Object.freeze(publicModule), path: safePath, source: await fs.readFile(sourcePath) });
  }

  private retain(module: ResolvedWebPluginModule): void {
    const key = retainedModuleKey(module.id, module.rev);
    this.retained.set(key, module);
    const history = this.retainedKeysByModule.get(module.id) ?? [];
    const next = [key, ...history.filter(item => item !== key)];
    while (next.length > MAX_RETAINED_REVISIONS_PER_MODULE) {
      const expired = next.pop();
      if (expired) this.retained.delete(expired);
    }
    this.retainedKeysByModule.set(module.id, next);
  }
}
