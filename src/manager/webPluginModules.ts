import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
import type { LoadedPluginProfile, PluginPackageCatalog } from "../plugin-kernel/profile.js";
import { loadPluginPackage, type LoadedPluginPackage } from "../plugin-kernel/packageLoader.js";
import type { PluginManifest } from "../plugin-kernel/types.js";

export type WebPluginModuleInstance = Readonly<{ instanceId: string }>;
export type WebPluginModule = Readonly<{
  id: string;
  pluginId: string;
  version: string;
  rev: string;
  entryPath: string;
  resourceMode?: "package";
  resourceIssue?: string;
  instances: readonly WebPluginModuleInstance[];
}>;
type ResolvedWebPluginModule = WebPluginModule & Readonly<{ rootPath: string; sourceRoot?: string; contentTypes?: ReadonlyMap<string, string> }>;
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

type PackagedWebResources = Readonly<{ contentTypes: ReadonlyMap<string, string>; issue?: string }>;
type PackagedWebResourceCache = Map<string, PackagedWebResources | undefined>;
/** Read and verify the package declaration once per immutable publication revision. */
export function readPackagedWebResources(root: string, expected: Readonly<{ id: string; version: string; entry: string; revision?: string }>,
  options: Readonly<{ verifyFiles?: boolean; cache?: PackagedWebResourceCache }> = {}): PackagedWebResources | undefined {
  const key = expected.revision ? `${root}\0${expected.revision}` : undefined;
  if (key && options.cache?.has(key)) return options.cache.get(key);
  const remember = (value: PackagedWebResources | undefined) => { if (key) options.cache?.set(key, value); return value; };
  let raw: string;
  try { raw = readFileSync(path.join(root, "web/module.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return remember(undefined);
    return remember({ contentTypes: new Map(), issue: "Package Web resource manifest could not be read." });
  }
  try {
    const manifest = JSON.parse(raw);
    if (manifest?.kind !== "rabi-plugin-web") return remember(undefined);
    if (manifest.schemaVersion !== 1 || manifest.pluginId !== expected.id || manifest.version !== expected.version
      || manifest.backend?.pluginId !== expected.id || manifest.backend.version !== expected.version
      || typeof manifest.entry !== 'string' || safeRelativePath("web/" + manifest.entry) !== safeRelativePath(expected.entry)
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.styles)
      || typeof manifest.runtime?.abi !== 'string' || !Array.isArray(manifest.runtime.imports)) throw new Error("Package Web resource manifest identity or entry is invalid.");
    const types = new Map<string, string>();
    for (const file of manifest.files) {
      const filename = safeRelativePath(file.path);
      if (types.has("web/" + filename) || typeof file.contentType !== 'string' || !file.contentType || /[\r\n]/.test(file.contentType)
        || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Package Web resource manifest file is invalid.");
      if (options.verifyFiles !== false) {
        const absolute = path.join(root, "web", filename);
        if (statSync(absolute).size !== file.size || createHash("sha256").update(readFileSync(absolute)).digest("hex") !== file.sha256) {
          throw new Error("Package Web resource manifest bytes differ from its file record: " + filename);
        }
      }
      types.set("web/" + filename, file.contentType);
    }
    if (!types.has(safeRelativePath(expected.entry)) || manifest.styles.some((filename: string) => !types.has("web/" + safeRelativePath(filename)))) throw new Error("Package Web resource manifest entry or style is missing.");
    return remember({ contentTypes: types });
  } catch (error) {
    return remember({ contentTypes: new Map(), issue: "Package Web resource manifest is invalid: " + (error instanceof Error ? error.message : "unreadable declaration") });
  }
}

export type RetainedWebPackageCatalog = Readonly<{
  list(): Promise<readonly { pluginId: string; version: string; manifest: PluginManifest }[]>;
  load(pluginId: string, version: string, revision: string): Promise<Readonly<{ package: LoadedPluginPackage; sourceRoot: string }>>;
}>;

/** Reuse the existing store and immutable loader; never execute a retired plugin. */
export function retainedWebPackageCatalog(options: Readonly<{
  packages: Pick<RetainedWebPackageCatalog, 'list'>;
  catalog: Pick<PluginPackageCatalog, 'resolve' | 'loadPackage'>;
  runtimeRoot: string;
}>): RetainedWebPackageCatalog {
  return {
    list: () => options.packages.list(),
    load: async (pluginId, version, revision) => {
      const source = await options.catalog.resolve(pluginId, version);
      const snapshot = path.join(options.runtimeRoot, encodeURIComponent(pluginId), version, revision);
      let retained = false;
      try { retained = (await fs.stat(snapshot)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const prepared = retained ? await loadPluginPackage(snapshot, options.runtimeRoot, 'web')
        : await options.catalog.loadPackage(pluginId, version, options.runtimeRoot, 'web');
      return { package: prepared, sourceRoot: source.sourceRoot };
    }
  };
}

export class WebPluginModuleRegistry {
  private current = new Map<string, ResolvedWebPluginModule>();
  private readonly retained = new Map<string, ResolvedWebPluginModule>();
  private readonly retainedKeysByModule = new Map<string, string[]>();
  private packageCatalog?: RetainedWebPackageCatalog;
  private packageIndex?: Map<string, { pluginId: string; version: string }>;
  private indexFlight?: Promise<Map<string, { pluginId: string; version: string }>>;
  private catalogEpoch = 0;
  private readonly restorations = new Map<string, Promise<ResolvedWebPluginModule | undefined>>();
  private readonly resourceDeclarations: PackagedWebResourceCache = new Map();

  setPackageCatalog(catalog: RetainedWebPackageCatalog): void { this.packageCatalog = catalog; this.invalidatePackageCatalog(); }
  invalidatePackageCatalog(): void { this.catalogEpoch++; this.packageIndex = undefined; this.indexFlight = undefined; this.restorations.clear(); }

  private indexPackages(): Promise<Map<string, { pluginId: string; version: string }>> {
    if (this.packageIndex) return Promise.resolve(this.packageIndex);
    if (this.indexFlight) return this.indexFlight;
    const catalog = this.packageCatalog, epoch = this.catalogEpoch;
    const work = (async () => {
      const index = new Map<string, { pluginId: string; version: string }>();
      for (const item of await catalog?.list() ?? []) if (item.manifest.entries.web) index.set(webModuleId(item.pluginId, item.version), { pluginId: item.pluginId, version: item.version });
      if (epoch === this.catalogEpoch) this.packageIndex = index;
      return index;
    })();
    this.indexFlight = work;
    void work.finally(() => { if (this.indexFlight === work) this.indexFlight = undefined; }).catch(() => {});
    return work;
  }

  private restore(id: string, revision: string): Promise<ResolvedWebPluginModule | undefined> {
    const key = retainedModuleKey(id, revision), original = this.restorations.get(key);
    if (original) return original;
    const catalog = this.packageCatalog;
    const work = (async () => {
      const item = (await this.indexPackages()).get(id);
      if (!item || !catalog) return undefined;
      const restored = await catalog.load(item.pluginId, item.version, revision), loaded = restored.package;
      if (loaded.revision !== revision || !loaded.manifest.entries.web) return undefined;
      const entry = loaded.manifest.entries.web;
      const resources = readPackagedWebResources(loaded.runtimeRoot, { id: loaded.manifest.id, version: loaded.manifest.version, entry: entry.execution === 'declarative' ? entry.resource : entry.module, revision: loaded.revision }, { cache: this.resourceDeclarations });
      const module: ResolvedWebPluginModule = Object.freeze({ id, pluginId: item.pluginId, version: item.version, rev: revision,
        entryPath: safeRelativePath(entry.execution === 'declarative' ? entry.resource : entry.module), instances: [],
        rootPath: loaded.runtimeRoot, sourceRoot: restored.sourceRoot,
        ...(resources ? { resourceMode: 'package' as const, contentTypes: resources.contentTypes, ...(resources.issue ? { resourceIssue: resources.issue } : {}) } : {}) });
      if (catalog === this.packageCatalog) this.retain(module);
      return module;
    })();
    this.restorations.set(key, work);
    void work.finally(() => { if (this.restorations.get(key) === work) this.restorations.delete(key); }).catch(() => {});
    return work;
  }

  list(): readonly WebPluginModule[] {
    return Object.freeze(
      [...this.current.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ rootPath: _rootPath, sourceRoot: _sourceRoot, contentTypes: _contentTypes, ...module }) => Object.freeze(module))
    );
  }

  update(loaded: LoadedPluginProfile, generation: PluginGeneration): void {
    const active = new Map(
      generation.records
        .filter(record => record.status === "active")
        .map(record => [record.identity.instanceId, record.identity] as const)
    );
    const pending = new Map<string, PendingWebPluginModule>();

    for (const item of loaded.packages) {
      const identity = active.get(item.instance.id);
      if (!identity) continue;
      if (item.package.manifest.id !== identity.pluginId || item.package.manifest.version !== identity.version
        || item.package.revision !== identity.revision) {
        throw new Error(`Active Web plugin package does not match its published activation: ${item.instance.id}.`);
      }
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

      const resources = readPackagedWebResources(item.package.runtimeRoot, { id: item.package.manifest.id, version: item.package.manifest.version, entry: entryPath, revision: item.package.revision }, { cache: this.resourceDeclarations });
      pending.set(id, {
        id,
        pluginId: item.package.manifest.id,
        version: item.package.manifest.version,
        rev: item.package.revision,
        entryPath,
        instances: [Object.freeze({ instanceId: item.instance.id })],
        rootPath: item.package.runtimeRoot, sourceRoot: item.package.sourceRoot,
        ...(resources ? { resourceMode: "package" as const, contentTypes: resources.contentTypes, ...(resources.issue ? { resourceIssue: resources.issue } : {}) } : {})
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
  ): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string; contentType?: string }>> {
    const safePath = safeRelativePath(relativePath);
    const current = this.current.get(id);
    const module = current?.rev === rev ? current : this.retained.get(retainedModuleKey(id, rev)) ?? await this.restore(id, rev);
    if (!module) throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    if (module.resourceIssue) throw Object.assign(new Error(module.resourceIssue), { code: "ENOENT" });

    // The metadata index and verified snapshot are cached. A single directory
    // existence check respects physical package removal without rescanning/hash.
    if (module.sourceRoot && !(await fs.stat(module.sourceRoot)).isDirectory()) throw Object.assign(new Error("Web plugin package is unavailable."), { code: "ENOENT" });
    const sourcePath = path.resolve(module.rootPath, safePath);
    const relative = path.relative(module.rootPath, sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Web plugin module was not found."), { code: "ENOENT" });
    }

    const { rootPath: _rootPath, sourceRoot: _sourceRoot, contentTypes, ...publicModule } = module;
    return Object.freeze({
      module: Object.freeze(publicModule),
      path: safePath, contentType: contentTypes?.get(safePath),
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
      if (expired) {
        const retired = this.retained.get(expired);
        if (retired) this.resourceDeclarations.delete(`${retired.rootPath}\0${retired.rev}`);
        this.retained.delete(expired);
      }
    }
    this.retainedKeysByModule.set(module.id, next);
  }
}


const WEB_PLUGIN_RESOURCE_TYPES: Readonly<Record<string, string>> = {
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};
/** MIME belongs to the revision-qualified resource owner, including lazy chunks and binary assets. */
export function webPluginModuleContentType(filename: string): string {
  return WEB_PLUGIN_RESOURCE_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
