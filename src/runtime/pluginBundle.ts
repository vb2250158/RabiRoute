import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RABI_PLUGIN_MANIFEST_FILE = "rabi.plugin.json";
export const RABI_PLUGIN_SCHEMA_VERSION = 1;

export type RabiPluginBundleManifest = Readonly<{
  schemaVersion: 1;
  id: string;
  version: string;
  hosts: readonly ("manager" | "web")[];
  entry: string;
  webEntry?: string;
}>;

export type LoadedRabiPluginBundle = Readonly<{
  rootDir: string;
  manifestPath: string;
  manifest: RabiPluginBundleManifest;
  revision: string;
  entryPath: string;
  webEntryPath?: string;
}>;

export type RabiPluginModule = Readonly<{
  createPlugin?: unknown;
}>;

function text(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`Rabi plugin ${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Rabi plugin ${field} is invalid.`);
  }
  return normalized;
}

function identifier(value: unknown, field: string): string {
  const normalized = text(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error(`Rabi plugin ${field} is invalid.`);
  }
  return normalized;
}

function version(value: unknown): string {
  const normalized = text(value, "version", 80);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(normalized)) {
    throw new Error("Rabi plugin version is invalid.");
  }
  return normalized;
}

function entry(value: unknown): string {
  const normalized = text(value, "entry", 240).replace(/\\/g, "/");
  if (!normalized.startsWith("./") || normalized.includes("../") || normalized.endsWith("/")) {
    throw new Error("Rabi plugin entry must be a relative file inside its bundle.");
  }
  return normalized;
}

function hosts(value: unknown): ("manager" | "web")[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Rabi plugin hosts are required.");
  const normalized = value.map(host => {
    if (host !== "manager" && host !== "web") throw new Error(`Unsupported Rabi plugin host: ${String(host)}.`);
    return host;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Rabi plugin hosts contain duplicates.");
  return normalized;
}

export function parseRabiPluginManifest(value: unknown): RabiPluginBundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rabi plugin manifest must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RABI_PLUGIN_SCHEMA_VERSION) {
    throw new Error(`Unsupported Rabi plugin manifest schema: ${String(record.schemaVersion)}.`);
  }
  const allowed = new Set(["schemaVersion", "id", "version", "hosts", "entry", "webEntry"]);
  const unknown = Object.keys(record).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Unsupported Rabi plugin manifest fields: ${unknown.sort().join(", ")}.`);
  return Object.freeze({
    schemaVersion: RABI_PLUGIN_SCHEMA_VERSION,
    id: identifier(record.id, "id"),
    version: version(record.version),
    hosts: Object.freeze(hosts(record.hosts)),
    entry: entry(record.entry),
    ...(record.webEntry === undefined ? {} : { webEntry: entry(record.webEntry) })
  });
}

async function filesRecursively(directory: string, rootDir = directory): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const item of entries) {
    if (item.name === ".git" || item.name === "node_modules" || item.name === ".rabi-runtime") continue;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      files.push(...await filesRecursively(absolute, rootDir));
      continue;
    }
    if (!item.isFile()) continue;
    files.push(path.relative(rootDir, absolute).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function hashRabiPluginBundle(rootDir: string): Promise<string> {
  const absoluteRoot = path.resolve(rootDir);
  const digest = createHash("sha256");
  for (const relative of await filesRecursively(absoluteRoot)) {
    const content = await fs.readFile(path.join(absoluteRoot, relative));
    digest.update(relative, "utf8");
    digest.update("\0", "utf8");
    digest.update(content);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function loadRabiPluginBundle(rootDir: string): Promise<LoadedRabiPluginBundle> {
  const absoluteRoot = path.resolve(rootDir);
  const manifestPath = path.join(absoluteRoot, RABI_PLUGIN_MANIFEST_FILE);
  const manifest = parseRabiPluginManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
  const entryPath = path.resolve(absoluteRoot, manifest.entry);
  if (!inside(absoluteRoot, entryPath)) throw new Error(`Rabi plugin entry escapes bundle: ${manifest.id}.`);
  const stat = await fs.stat(entryPath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`Rabi plugin entry is missing: ${manifest.id}.`);
  const webEntryPath = manifest.webEntry ? path.resolve(absoluteRoot, manifest.webEntry) : undefined;
  if (webEntryPath && (!inside(absoluteRoot, webEntryPath) || !(await fs.stat(webEntryPath).catch(() => undefined))?.isFile())) {
    throw new Error(`Rabi plugin web entry is missing or escapes its bundle: ${manifest.id}.`);
  }
  return Object.freeze({
    rootDir: absoluteRoot,
    manifestPath,
    manifest,
    revision: await hashRabiPluginBundle(absoluteRoot),
    entryPath,
    ...(webEntryPath ? { webEntryPath } : {})
  });
}

function safeDirectoryPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export async function materializeRabiPluginRevisionRoot(
  bundle: LoadedRabiPluginBundle,
  runtimeRoot: string
): Promise<string> {
  const target = path.join(
    path.resolve(runtimeRoot),
    safeDirectoryPart(bundle.manifest.id),
    safeDirectoryPart(bundle.manifest.version),
    bundle.revision
  );
  const marker = path.join(target, ".complete");
  if (!(await fs.stat(marker).catch(() => undefined))) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(bundle.rootDir, staging, {
      recursive: true,
      filter: source => !["node_modules", ".git", ".rabi-runtime"].includes(path.basename(source))
    });
    await fs.writeFile(path.join(staging, ".complete"), bundle.revision, "utf8");
    try {
      await fs.rename(staging, target);
    } catch (error: unknown) {
      await fs.rm(staging, { recursive: true, force: true });
      if (!(await fs.stat(marker).catch(() => undefined))) throw error;
    }
  }
  return target;
}

export async function materializeRabiPluginRevision(
  bundle: LoadedRabiPluginBundle,
  runtimeRoot: string
): Promise<string> {
  return path.join(await materializeRabiPluginRevisionRoot(bundle, runtimeRoot), bundle.manifest.entry);
}

export async function importRabiPluginModule(
  bundle: LoadedRabiPluginBundle,
  runtimeRoot: string
): Promise<RabiPluginModule> {
  const entryPath = await materializeRabiPluginRevision(bundle, runtimeRoot);
  return await import(pathToFileURL(entryPath).href) as RabiPluginModule;
}
