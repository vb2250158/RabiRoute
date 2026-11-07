import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { hashPluginPackage, loadPluginPackage } from "../plugin-kernel/packageLoader.js";
import { PLUGIN_HOSTS, type PluginManifest } from "../plugin-kernel/types.js";

export type AvailablePluginPackage = Readonly<{ pluginId: string; version: string; manifest: PluginManifest; source: "bundled" | "local" }>;

/** Installed release packages stay immutable. User imports have their own persistent package root. */
export class PluginPackageStore {
  constructor(readonly options: Readonly<{ roots: readonly string[]; managedRoot: string; importRuntimeRoot: string; bundledRoot?: string }>) {}

  async list(): Promise<readonly AvailablePluginPackage[]> {
    const packages = new Map<string, AvailablePluginPackage>();
    for (const root of this.options.roots) {
      let identities;
      try { identities = await fs.readdir(root, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const identity of identities) {
        if (!identity.isDirectory() || identity.name.startsWith(".")) continue;
        let versions;
        try { versions = await fs.readdir(path.join(root, identity.name), { withFileTypes: true }); }
        catch { continue; }
        for (const version of versions) {
          if (!version.isDirectory()) continue;
          try {
            const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(root, identity.name, version.name, "rabi.plugin.json"), "utf8")));
            if (manifest.id !== identity.name || manifest.version !== version.name) continue;
            const key = JSON.stringify([manifest.id, manifest.version]);
            if (!packages.has(key)) packages.set(key, { pluginId: manifest.id, version: manifest.version, manifest,
              source: this.options.bundledRoot && path.resolve(root) === path.resolve(this.options.bundledRoot) ? "bundled" : "local" });
          } catch { /* An unreadable package does not remove unrelated install choices. */ }
        }
      }
    }
    return [...packages.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.version.localeCompare(b.version));
  }

  async importDirectory(sourceDirectory: string, assertCurrent: () => void, expected?: Readonly<{ id: string; version: string }>): Promise<void> {
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
      if (expected && (prepared.manifest.id !== expected.id || prepared.manifest.version !== expected.version)) {
        throw Object.assign(new Error("The selected plugin package changed while it was being imported."), { status: 409, code: "PLUGIN_PACKAGE_IDENTITY_CHANGED" });
      }
      const target = path.join(this.options.managedRoot, prepared.manifest.id, prepared.manifest.version);
      for (const root of this.options.roots) {
        const existing = path.join(root, prepared.manifest.id, prepared.manifest.version);
        try {
          if (await hashPluginPackage(existing) !== prepared.revision) throw Object.assign(new Error("This plugin version already exists with different bytes. Publish a new plugin version."), { status: 409, code: "PLUGIN_PACKAGE_VERSION_CONFLICT" });
          if (path.resolve(root) === path.resolve(this.options.managedRoot)) return;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertCurrent();
      try { await fs.rename(prepared.runtimeRoot, target); }
      catch (error) {
        // Concurrent imports of the exact same version converge; different bytes never overwrite it.
        try { if (await hashPluginPackage(target) === prepared.revision) return; }
        catch { /* Keep the original publication error. */ }
        throw error;
      }
    } finally {
      // This exact immutable staging snapshot belongs to this import, never a caller-supplied deletion path.
      const relative = path.relative(importRoot, operationRoot);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plugin import cleanup escaped its operation root.");
      await fs.rm(operationRoot, { recursive: true, force: true });
    }
  }
}
