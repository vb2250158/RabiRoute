import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
import type { LoadedPluginProfile } from "../plugin-kernel/profile.js";

export type WebPluginModuleInstance = Readonly<{ instanceId: string }>;
export type WebPluginModule = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  instances: readonly WebPluginModuleInstance[];
}>;
type ResolvedWebPluginModule = WebPluginModule & Readonly<{ rootPath: string }>;
type PendingWebPluginModule = Omit<ResolvedWebPluginModule, "instances"> & { instances: WebPluginModuleInstance[] };

const MAX_RETAINED_REVISIONS_PER_MODULE = 8;

function retainedModuleKey(id: string, rev: string): string {
  return `${id}\0${rev}`;
}

function webModuleId(pluginId: string, version: string): string {
  return `web-${createHash("sha256").update(`${pluginId}\0${version}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.includes("\0")
    || normalized.split("/").some(part => !part || part === "." || part === "..")
  ) {
    throw Object.assign(new Error("Web plugin module path is invalid."), { code: "ENOENT" });
  }
  return normalized;
}

export class WebPluginModuleRegistry {
  private current = new Map<string, ResolvedWebPluginModule>();
  private readonly retained = new Map<string, ResolvedWebPluginModule>();
  private readonly retainedKeysByModule = new Map<string, string[]>();

  list(): readonly WebPluginModule[] {
    return Object.freeze(
      [...this.current.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ rootPath: _rootPath, ...module }) => Object.freeze(module))
    );
  }

  update(loaded: LoadedPluginProfile, generation: PluginGeneration): void {
    const active = new Set(
      generation.records
        .filter(record => record.status === "active")
        .map(record => record.identity.instanceId)
    );
    const pending = new Map<string, PendingWebPluginModule>();

    for (const item of loaded.packages) {
      if (!active.has(item.instance.id)) continue;
      const webEntry = item.package.manifest.entries.web;
      if (!webEntry) continue;

      const id = webModuleId(item.package.manifest.id, item.package.manifest.version);
      const entryPath = safeRelativePath(
        webEntry.execution === "declarative" ? webEntry.resource : webEntry.module
      );
      const existing = pending.get(id);
      if (existing) {
        if (
          existing.rev !== item.package.revision
          || existing.entryPath !== entryPath
          || existing.rootPath !== item.package.runtimeRoot
        ) {
          throw new Error(`Active Web plugin package has inconsistent revision or entry: ${item.package.manifest.id}@${item.package.manifest.version}.`);
        }
        existing.instances.push(Object.freeze({ instanceId: item.instance.id }));
        continue;
      }

      pending.set(id, {
        id,
        pluginId: item.package.manifest.id,
        version: item.package.manifest.version,
        rev: item.package.revision,
        entryPath,
        instances: [Object.freeze({ instanceId: item.instance.id })],
        rootPath: item.package.runtimeRoot
      });
    }

    const next = new Map<string, ResolvedWebPluginModule>();
    for (const item of pending.values()) {
      const module: ResolvedWebPluginModule = Object.freeze({
        ...item,
        instances: Object.freeze(
          [...item.instances].sort((left, right) => left.instanceId.localeCompare(right.instanceId))
        )
      });
      next.set(module.id, module);
      this.retain(module);
    }
    this.current = next;
  }

  async read(
    id: string,
    rev: string,
    relativePath: string
  ): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string }>> {
    const current = this.current.get(id);
    const module = current?.rev === rev ? current : this.retained.get(retainedModuleKey(id, rev));
    if (!module) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });

    const safePath = safeRelativePath(relativePath);
    const sourcePath = path.resolve(module.rootPath, safePath);
    const relative = path.relative(module.rootPath, sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    }

    const { rootPath: _rootPath, ...publicModule } = module;
    return Object.freeze({
      module: Object.freeze(publicModule),
      path: safePath,
      source: await fs.readFile(sourcePath)
    });
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
