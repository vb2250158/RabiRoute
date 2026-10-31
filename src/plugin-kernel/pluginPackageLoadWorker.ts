import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginPackage } from "./packageLoader.js";
import { PluginPackageCatalog, readPluginProfile } from "./profile.js";
import type { PluginPackageLoadReply, PluginPackageLoadRequest } from "./pluginPackageLoader.js";

export async function executePluginPackageLoad(request: PluginPackageLoadRequest): Promise<PluginPackageLoadReply> {
  try {
    const task = request.task;
    if (task.kind === "profile") return { id: request.id, ok: true, value: await readPluginProfile(task.profilePath) };
    if (task.kind === "cleanup") {
      if (!/^[0-9a-f-]{36}$/i.test(task.stagingId)) throw new Error("Invalid plugin staging cleanup identity.");
      const root = path.resolve(task.runtimeRoot), stagingRoot = path.join(root, ".staging");
      for (const directory of [root, stagingRoot]) {
        let stat;
        try { stat = await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: request.id, ok: true, value: undefined }; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin staging cleanup root must be a plain directory.");
      }
      await fs.rm(path.join(stagingRoot, task.stagingId), { recursive: true, force: true });
      return { id: request.id, ok: true, value: undefined };
    }
    const catalog = new PluginPackageCatalog(task.roots.map(root => root.path), {
      trustedInProcessRoots: task.roots.filter(root => root.inProcessTrusted).map(root => root.path)
    });
    const resolved = await catalog.resolve(task.packageId, task.version);
    const loaded = await loadPluginPackage(resolved.sourceRoot, task.runtimeRoot, task.host, { stagingId: request.id });
    if (loaded.manifest.id !== task.packageId || loaded.manifest.version !== task.version) throw new Error(`Plugin profile identity does not match package manifest: ${task.packageId}@${task.version}.`);
    if (loaded.execution === "in_process" && !resolved.inProcessTrusted) {
      throw new Error(`Plugin in_process execution is disabled by the configured trustedInProcessRoots: ${JSON.stringify(task.roots.filter(root => root.inProcessTrusted).map(root => root.path))}; package=${task.packageId}@${task.version}, root=${resolved.sourceRoot}. Change or clear RABIROUTE_PLUGIN_IN_PROCESS_ROOTS in the Manager startup environment (or trustedInProcessRoots in an embedded catalog).`);
    }
    return { id: request.id, ok: true, value: loaded };
  } catch (error) { return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let complete = false;
  process.once("disconnect", () => { if (!complete) process.exit(1); });
  process.once("message", (request: PluginPackageLoadRequest) => {
    void executePluginPackageLoad(request).then(reply => {
      complete = true;
      process.send?.(reply, () => process.disconnect?.());
    });
  });
}
