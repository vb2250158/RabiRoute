import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePluginManifest } from "./manifest.js";
import type { PluginExecutionMode, PluginHost, PluginManifest } from "./types.js";

export const PLUGIN_MANIFEST_FILE = "rabi.plugin.json";

export type LoadedPluginPackage = Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  manifest: PluginManifest;
  revision: string;
  entryPath: string;
  execution: PluginExecutionMode;
}>;

type PackageFile = Readonly<{ relative: string; absolute: string }>;

function ignored(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".rabi-runtime";
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertPlainDirectory(directory: string, field: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${field} must be a plain directory without symlink or reparse traversal.`);
  }
}

async function packageFiles(directory: string, root = directory): Promise<PackageFile[]> {
  await assertPlainDirectory(directory, "Plugin package directory");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: PackageFile[] = [];
  for (const entry of entries) {
    if (ignored(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new Error(`Plugin package contains a symlink or reparse point: ${path.relative(root, absolute)}.`);
    }
    if (stat.isDirectory()) files.push(...await packageFiles(absolute, root));
    else if (stat.isFile()) files.push(Object.freeze({
      relative: path.relative(root, absolute).replace(/\\/g, "/"),
      absolute
    }));
    else throw new Error(`Plugin package contains an unsupported filesystem entry: ${path.relative(root, absolute)}.`);
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

async function copyPackageTree(source: string, destination: string, root = source): Promise<void> {
  await assertPlainDirectory(source, "Plugin package source");
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (ignored(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const stat = await fs.lstat(sourcePath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new Error(`Plugin package contains a symlink or reparse point: ${path.relative(root, sourcePath)}.`);
    }
    if (stat.isDirectory()) await copyPackageTree(sourcePath, destinationPath, root);
    else if (stat.isFile()) await fs.copyFile(sourcePath, destinationPath);
    else throw new Error(`Plugin package contains an unsupported filesystem entry: ${path.relative(root, sourcePath)}.`);
  }
}

export async function hashPluginPackage(packageRoot: string): Promise<string> {
  const root = path.resolve(packageRoot);
  const digest = createHash("sha256");
  for (const file of await packageFiles(root)) {
    digest.update(file.relative, "utf8").update("\0");
    digest.update(await fs.readFile(file.absolute)).update("\0");
  }
  return digest.digest("hex");
}

async function resolveEntry(
  runtimeRoot: string,
  manifest: PluginManifest,
  host: PluginHost
): Promise<Readonly<{ entryPath: string; execution: PluginExecutionMode }>> {
  const entry = manifest.entries[host];
  if (!entry) throw new Error(`Plugin does not support host ${host}: ${manifest.id}.`);
  const relativeEntry = entry.execution === "declarative" ? entry.resource : entry.module;
  const runtimeReal = await fs.realpath(runtimeRoot);
  const lexicalEntry = path.resolve(runtimeRoot, relativeEntry);
  if (!inside(path.resolve(runtimeRoot), lexicalEntry)) {
    throw new Error(`Plugin entry escapes its runtime package: ${manifest.id}.`);
  }
  const entryReal = await fs.realpath(lexicalEntry);
  if (!inside(runtimeReal, entryReal)) throw new Error(`Plugin entry escapes its runtime package: ${manifest.id}.`);
  const stat = await fs.lstat(entryReal);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Plugin entry is not a plain file: ${manifest.id} (${host}).`);
  return Object.freeze({ entryPath: entryReal, execution: entry.execution });
}

async function verifyRuntimePackage(
  runtimeRoot: string,
  expected: Readonly<{ revision: string; id: string; version: string }>,
  host: PluginHost
): Promise<Readonly<{ manifest: PluginManifest; entryPath: string; execution: PluginExecutionMode }>> {
  const revision = await hashPluginPackage(runtimeRoot);
  if (revision !== expected.revision) throw new Error(`Existing plugin runtime revision failed integrity verification: ${expected.id}@${expected.version}.`);
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(runtimeRoot, PLUGIN_MANIFEST_FILE), "utf8")) as unknown);
  if (manifest.id !== expected.id || manifest.version !== expected.version) {
    throw new Error(`Existing plugin runtime identity mismatch: ${expected.id}@${expected.version}.`);
  }
  const entry = await resolveEntry(runtimeRoot, manifest, host);
  return Object.freeze({ manifest, ...entry });
}

export async function loadPluginPackage(sourceRoot: string, runtimeRoot: string, host: PluginHost): Promise<LoadedPluginPackage> {
  const source = path.resolve(sourceRoot);
  const runtimeBase = path.resolve(runtimeRoot);
  await assertPlainDirectory(source, "Plugin package source");
  await fs.mkdir(runtimeBase, { recursive: true });
  await assertPlainDirectory(runtimeBase, "Plugin runtime root");

  const stagingParent = path.join(runtimeBase, ".staging");
  await fs.mkdir(stagingParent, { recursive: true });
  await assertPlainDirectory(stagingParent, "Plugin staging root");
  const staging = path.join(stagingParent, randomUUID());
  await fs.mkdir(staging);
  try {
    await copyPackageTree(source, staging);
    // The staged tree is authoritative. Hashing the source before copying would
    // allow source mutation to select a revision for different runtime bytes.
    const revision = await hashPluginPackage(staging);
    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(staging, PLUGIN_MANIFEST_FILE), "utf8")) as unknown);
    await resolveEntry(staging, manifest, host);

    const packageRuntimeRoot = path.join(runtimeBase, encodeURIComponent(manifest.id));
    await fs.mkdir(packageRuntimeRoot, { recursive: true });
    await assertPlainDirectory(packageRuntimeRoot, "Plugin runtime identity root");
    const versionRuntimeRoot = path.join(packageRuntimeRoot, manifest.version);
    await fs.mkdir(versionRuntimeRoot, { recursive: true });
    await assertPlainDirectory(versionRuntimeRoot, "Plugin runtime version root");
    const target = path.join(versionRuntimeRoot, revision);
    try {
      await fs.rename(staging, target);
    } catch (error) {
      try {
        const targetStat = await fs.lstat(target);
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw error;
      } catch (targetError) {
        if ((targetError as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw targetError;
      }
      await verifyRuntimePackage(target, { revision, id: manifest.id, version: manifest.version }, host);
      await fs.rm(staging, { recursive: true, force: true });
    }

    const verified = await verifyRuntimePackage(target, { revision, id: manifest.id, version: manifest.version }, host);
    return Object.freeze({
      sourceRoot: source,
      runtimeRoot: target,
      manifest: verified.manifest,
      revision,
      entryPath: verified.entryPath,
      execution: verified.execution
    });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
