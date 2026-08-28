import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePluginManifest } from "./manifest.js";
import type { PluginHost, PluginManifest, PluginModule } from "./types.js";

export const PLUGIN_MANIFEST_FILE = "rabi.plugin.json";

export type LoadedPluginPackage = Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  manifest: PluginManifest;
  revision: string;
  entryPath: string;
  module: PluginModule;
}>;

async function filesRecursively(directory: string, root = directory): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".rabi-runtime") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(absolute, root));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function hashPluginPackage(sourceRoot: string): Promise<string> {
  const root = path.resolve(sourceRoot);
  const digest = createHash("sha256");
  for (const relative of await filesRecursively(root)) {
    digest.update(relative, "utf8").update("\0");
    digest.update(await fs.readFile(path.join(root, relative))).update("\0");
  }
  return digest.digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function ensureRuntimeCopy(sourceRoot: string, runtimeRoot: string, manifest: PluginManifest, revision: string): Promise<string> {
  const target = path.join(path.resolve(runtimeRoot), encodeURIComponent(manifest.id), manifest.version, revision);
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.staging-${randomUUID()}`;
  try {
    await fs.cp(path.resolve(sourceRoot), staging, { recursive: true, force: false, errorOnExist: true });
    await fs.rename(staging, target).catch(async error => {
      try {
        if ((await fs.stat(target)).isDirectory()) {
          await fs.rm(staging, { recursive: true, force: true });
          return;
        }
      } catch {
        // The target still does not exist; preserve the original rename error.
      }
      throw error;
    });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return target;
}

function validateModule(value: unknown, manifest: PluginManifest, host: PluginHost): PluginModule {
  if (!value || typeof value !== "object" || typeof (value as { activate?: unknown }).activate !== "function") {
    throw new Error(`Plugin ${manifest.id} ${host} entry must export activate(context).`);
  }
  return Object.freeze({ activate: (value as PluginModule).activate });
}

export async function loadPluginPackage(sourceRoot: string, runtimeRoot: string, host: PluginHost): Promise<LoadedPluginPackage> {
  const source = path.resolve(sourceRoot);
  const manifestPath = path.join(source, PLUGIN_MANIFEST_FILE);
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
  const entry = manifest.entries[host];
  if (!entry) throw new Error(`Plugin does not support host ${host}: ${manifest.id}.`);
  const revision = await hashPluginPackage(source);
  const runtime = await ensureRuntimeCopy(source, runtimeRoot, manifest, revision);
  const entryPath = path.resolve(runtime, entry);
  if (!inside(runtime, entryPath)) throw new Error(`Plugin entry escapes its runtime package: ${manifest.id}.`);
  const stat = await fs.stat(entryPath);
  if (!stat.isFile()) throw new Error(`Plugin entry is not a file: ${manifest.id} (${host}).`);
  const imported = await import(pathToFileURL(entryPath).href);
  const module = validateModule(imported, manifest, host);
  return Object.freeze({ sourceRoot: source, runtimeRoot: runtime, manifest, revision, entryPath, module });
}
