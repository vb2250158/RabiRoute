import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { hashPluginPackage, loadPluginPackage } from "../plugin-kernel/packageLoader.js";
import { PLUGIN_HOSTS, type PluginManifest } from "../plugin-kernel/types.js";

export type AvailablePluginPackage = Readonly<{ pluginId: string; version: string; manifest: PluginManifest; source: "bundled" | "local" }>;
export type PluginPackageListDiagnostic = Readonly<{ root: string; path: string; code: string; message: string }>;
export type ImportedPluginPackage = Readonly<{ id: string; version: string; revision: string }>;

/** Installed release packages stay immutable. User imports have their own persistent package root. */
export class PluginPackageStore {
  constructor(readonly options: Readonly<{ roots: readonly string[]; managedRoot: string; importRuntimeRoot: string; bundledRoot?: string }>) {}

  async list(): Promise<readonly AvailablePluginPackage[]> {
    return (await this.listResult()).packages;
  }

  async listResult(): Promise<{ packages: readonly AvailablePluginPackage[]; diagnostics: readonly PluginPackageListDiagnostic[]; partial: boolean }> {
    const packages = new Map<string, AvailablePluginPackage>();
    const diagnostics: PluginPackageListDiagnostic[] = [];
    const report = (root: string, file: string, error: unknown) => diagnostics.push({ root, path: file,
      code: (error as NodeJS.ErrnoException)?.code ?? "PLUGIN_PACKAGE_UNREADABLE", message: error instanceof Error ? error.message : String(error) });
    for (const root of this.options.roots) {
      let identities;
      try { identities = await fs.readdir(root, { withFileTypes: true }); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        // Filesystem failure belongs to this source root. The invocation owner
        // separately checks caller authority before and after enumeration.
        report(root, root, error); continue;
      }
      for (const identity of identities) {
        if (!identity.isDirectory() || identity.name.startsWith(".")) continue;
        let versions;
        try { versions = await fs.readdir(path.join(root, identity.name), { withFileTypes: true }); }
        catch (error) { report(root, path.join(root, identity.name), error); continue; }
        for (const version of versions) {
          if (!version.isDirectory()) continue;
          try {
            const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(root, identity.name, version.name, "rabi.plugin.json"), "utf8")));
            if (manifest.id !== identity.name || manifest.version !== version.name) throw new Error("Plugin manifest identity differs from its package directory.");
            const key = JSON.stringify([manifest.id, manifest.version]);
            if (!packages.has(key)) packages.set(key, { pluginId: manifest.id, version: manifest.version, manifest,
              source: this.options.bundledRoot && path.resolve(root) === path.resolve(this.options.bundledRoot) ? "bundled" : "local" });
          } catch (error) { report(root, path.join(root, identity.name, version.name), error); }
        }
      }
    }
    return { packages: [...packages.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.version.localeCompare(b.version)), diagnostics, partial: diagnostics.length > 0 };
  }

  async importDirectory(sourceDirectory: string, assertCurrent: () => void, expected?: Readonly<{ id: string; version: string }>): Promise<ImportedPluginPackage> {
    assertCurrent();
    const source = path.resolve(sourceDirectory);
    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8")));
    const host = PLUGIN_HOSTS.find(host => manifest.entries[host]);
    if (!host) throw Object.assign(new Error("Plugin package has no executable or declarative entry."), { status: 400, code: "PLUGIN_PACKAGE_ENTRY_MISSING" });
    // The original package loader owns tree validation, entry resolution and the immutable byte snapshot.
    const importRoot = path.resolve(this.options.importRuntimeRoot);
    const operationRoot = path.join(importRoot, randomUUID());
    try {
      const prepared = await loadPluginPackage(source, operationRoot, host);
      const imported = Object.freeze({ id: prepared.manifest.id, version: prepared.manifest.version, revision: prepared.revision });
      if (expected && (prepared.manifest.id !== expected.id || prepared.manifest.version !== expected.version)) {
        throw Object.assign(new Error("The selected plugin package changed while it was being imported."), { status: 409, code: "PLUGIN_PACKAGE_IDENTITY_CHANGED" });
      }
      const target = path.join(this.options.managedRoot, prepared.manifest.id, prepared.manifest.version);
      for (const root of this.options.roots) {
        const existing = path.join(root, prepared.manifest.id, prepared.manifest.version);
        try {
          if (await hashPluginPackage(existing) !== prepared.revision) throw Object.assign(new Error("This plugin version already exists with different bytes. Publish a new plugin version."), { status: 409, code: "PLUGIN_PACKAGE_VERSION_CONFLICT" });
          if (path.resolve(root) === path.resolve(this.options.managedRoot)) return imported;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertCurrent();
      try {
        await fs.rename(prepared.runtimeRoot, target);
        recordDataMutationAudit({ group: "plugins", event: "plugin_package_imported", owner: "plugin-package-store",
          action: "import", target: { type: "plugin-package", id: prepared.manifest.id + "@" + prepared.manifest.version },
          dataSource: { kind: "file", id: target }, outcome: "committed", after: { digest: prepared.revision } });
      }
      catch (error) {
        // Concurrent imports of the exact same version converge; different bytes never overwrite it.
        try { if (await hashPluginPackage(target) === prepared.revision) return imported; }
        catch { /* Keep the original publication error. */ }
        throw error;
      }
      return imported;
    } finally {
      // This exact immutable staging snapshot belongs to this import, never a caller-supplied deletion path.
      const relative = path.relative(importRoot, operationRoot);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plugin import cleanup escaped its operation root.");
      await fs.rm(operationRoot, { recursive: true, force: true });
    }
  }
}
