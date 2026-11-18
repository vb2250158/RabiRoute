import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { hashPluginPackage, loadPluginPackage } from "../plugin-kernel/packageLoader.js";
import { PLUGIN_HOSTS, type PluginManifest } from "../plugin-kernel/types.js";

export type AvailablePluginPackage = Readonly<{ pluginId: string; version: string; manifest: PluginManifest; source: "bundled" | "local" }>;
export type PluginPackageListDiagnostic = Readonly<{ root: string; path: string; code: string; message: string }>;
export type ImportedPluginPackage = Readonly<{ id: string; version: string; revision: string }>;
/** Preview of a plugin archive fetched from a URL, before anything is installed. */
export type InspectedRemotePackage = Readonly<{
  id: string;
  version: string;
  manifest: PluginManifest;
  /** Directory inside the archive that owns the manifest; empty means the root. */
  packagePath: string;
  /** False when the archive only holds source (built entries are missing). */
  runnable: boolean;
  /** Entry files the manifest declares but the archive does not contain. */
  missingEntries: readonly string[];
}>;

export type RemoteArchiveInspection = Readonly<{
  archiveSha256: string;
  archiveBytes: number;
  sourceUrl: string;
  packages: readonly InspectedRemotePackage[];
}>;

// A plugin archive is small by construction; anything larger is either a wrong
// URL or an attempt to exhaust the Manager's disk through the import endpoint.
const MAX_REMOTE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const REMOTE_ARCHIVE_TIMEOUT_MS = 60_000;

function pluginPackageError(message: string, code: string, status = 400): Error {
  return Object.assign(new Error(message), { status, code });
}

function tarBinary(): string {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(tarBinary(), ["-xf", archivePath, "-C", destination], { timeout: 120_000 }, error => {
      if (error) reject(pluginPackageError(`Plugin archive extraction failed: ${error.message}`, "PLUGIN_PACKAGE_EXTRACT_FAILED"));
      else resolve();
    });
  });
}

const MANIFEST_NAME = "rabi.plugin.json";
// Directories that never hold the intended package and can be huge in a repo tarball.
const UNSCANNED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", "__pycache__", "dist", "build"]);

export type ResolvedPackageRoot = Readonly<{ root: string; relativePath: string }>;

async function findManifestRoots(root: string, depth: number, limit = 200): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, remaining: number): Promise<void> => {
    if (found.length >= limit) return;
    if (await exists(path.join(directory, MANIFEST_NAME))) { found.push(directory); return; }
    if (remaining <= 0) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || UNSCANNED_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(directory, entry.name), remaining - 1);
    }
  };
  await walk(root, depth);
  return found;
}

/**
 * Every plugin package inside an archive. A repository can hold many plugins, so
 * the caller sees the list and picks one instead of guessing a path.
 */
async function discoverPackages(source: string, subdirectory?: string): Promise<Array<{ root: string; relativePath: string }>> {
  if (subdirectory && subdirectory.trim()) {
    return [await resolvePackageRoot(source, subdirectory)];
  }
  if (await exists(path.join(source, MANIFEST_NAME))) return [{ root: source, relativePath: "" }];
  const entries = await fs.readdir(source, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  if (directories.length === 1) {
    const nested = path.join(source, directories[0].name);
    if (await exists(path.join(nested, MANIFEST_NAME))) return [{ root: nested, relativePath: directories[0].name }];
  }
  const normalizedSource = path.resolve(source);
  return (await findManifestRoots(normalizedSource, 4)).map(root => ({
    root,
    relativePath: path.relative(normalizedSource, root).split(path.sep).join("/")
  }));
}

/**
 * A repository source directory carries rabi.plugin.json but not the built
 * entries (web/client.mjs and friends are produced by `npm run build`). Report
 * which entries are absent so the UI can say "source only" before installing.
 */
async function collectMissingEntries(root: string, manifest: PluginManifest): Promise<string[]> {
  const missing: string[] = [];
  let entries: Record<string, unknown> = {};
  try { entries = (manifest as unknown as { entries?: Record<string, unknown> }).entries ?? {}; }
  catch { entries = {}; }
  const normalizedRoot = path.resolve(root);
  for (const [host, value] of Object.entries(entries)) {
    const moduleRelative = (value as { module?: unknown })?.module;
    if (typeof moduleRelative !== "string" || !moduleRelative) continue;
    const target = path.resolve(root, moduleRelative);
    if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) continue;
    if (!(await exists(target))) missing.push(`${host} → ${moduleRelative}`);
  }
  return missing;
}

/**
 * Turn a GitHub browse URL into a downloadable archive.
 *
 * `https://github.com/o/r/tree/main/src/plugins/x` becomes
 * `https://github.com/o/r/archive/refs/heads/main.zip` with `src/plugins/x` as the
 * implied package directory, so pasting a repository path works directly. A bare
 * repository URL tries `main` and then `master`. Non-GitHub URLs pass through.
 */
function normalizeRemoteUrl(raw: string): { candidateUrls: string[]; impliedSubdirectory: string } {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return { candidateUrls: [raw], impliedSubdirectory: "" }; }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { candidateUrls: [raw], impliedSubdirectory: "" };
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return { candidateUrls: [raw], impliedSubdirectory: "" };
  const [owner, repo, kind, ref, ...rest] = parts;
  if (kind === "tree" && ref) {
    const path = rest.join("/");
    const refs = [`https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.zip`,
      `https://github.com/${owner}/${repo}/archive/refs/tags/${ref}.zip`];
    return { candidateUrls: refs, impliedSubdirectory: path };
  }
  if (kind === "archive" || kind === "releases" || kind === "raw") {
    return { candidateUrls: [raw], impliedSubdirectory: "" };
  }
  if (!kind) {
    return {
      candidateUrls: [`https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`,
        `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`],
      impliedSubdirectory: ""
    };
  }
  return { candidateUrls: [raw], impliedSubdirectory: "" };
}

async function readResponseToFile(response: Response, archivePath: string): Promise<{ sha256: string; bytes: number }> {
  if (!response.body) throw pluginPackageError("Plugin archive download returned no content.", "PLUGIN_PACKAGE_DOWNLOAD_FAILED");
  const digest = createHash("sha256");
  const handle = await fs.open(archivePath, "w");
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_REMOTE_ARCHIVE_BYTES) throw pluginPackageError("Plugin archive exceeds the 64 MB import limit.", "PLUGIN_PACKAGE_TOO_LARGE", 413);
      digest.update(chunk);
      await handle.write(chunk);
    }
  } finally { await handle.close(); }
  if (bytes === 0) throw pluginPackageError("Plugin archive download produced an empty file.", "PLUGIN_PACKAGE_DOWNLOAD_FAILED");
  return { sha256: digest.digest("hex"), bytes };
}

/**
 * Resolve the directory that owns rabi.plugin.json.
 *
 * `subdirectory` wins when the caller names one (monorepos, plugin collections).
 * Otherwise the archive root, a single wrapper directory, and finally a bounded
 * search are tried; several manifests are reported instead of guessed, because
 * silently picking one would install a plugin the user did not review.
 */
async function resolvePackageRoot(source: string, subdirectory?: string): Promise<ResolvedPackageRoot> {
  const normalizedSource = path.resolve(source);
  if (subdirectory && subdirectory.trim()) {
    const requested = subdirectory.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const segments = requested.split("/");
    if (!requested || segments.some(segment => !segment || segment === "." || segment === "..")) {
      throw pluginPackageError("Plugin subdirectory must be a relative path inside the archive.", "PLUGIN_PACKAGE_SUBDIRECTORY_INVALID");
    }
    const target = path.resolve(normalizedSource, requested);
    if (target !== normalizedSource && !target.startsWith(normalizedSource + path.sep)) {
      throw pluginPackageError("Plugin subdirectory escapes the downloaded archive.", "PLUGIN_PACKAGE_SUBDIRECTORY_INVALID");
    }
    if (!(await exists(path.join(target, MANIFEST_NAME)))) {
      throw pluginPackageError(`No ${MANIFEST_NAME} under the requested subdirectory: ${requested}`, "PLUGIN_PACKAGE_MANIFEST_MISSING");
    }
    return { root: target, relativePath: requested };
  }

  if (await exists(path.join(normalizedSource, MANIFEST_NAME))) {
    return { root: normalizedSource, relativePath: "" };
  }
  const entries = await fs.readdir(normalizedSource, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  if (directories.length === 1) {
    const nested = path.join(normalizedSource, directories[0].name);
    if (await exists(path.join(nested, MANIFEST_NAME))) {
      return { root: nested, relativePath: directories[0].name };
    }
  }
  const discovered = await findManifestRoots(normalizedSource, 3);
  if (discovered.length === 1) {
    const relativePath = path.relative(normalizedSource, discovered[0]).split(path.sep).join("/");
    return { root: discovered[0], relativePath };
  }
  if (discovered.length > 1) {
    const candidates = discovered
      .slice(0, 5)
      .map(candidate => path.relative(normalizedSource, candidate).split(path.sep).join("/") || "(archive root)");
    throw pluginPackageError(
      `The archive contains ${discovered.length} plugin packages. Specify the subdirectory, for example: ${candidates.join(", ")}`,
      "PLUGIN_PACKAGE_SUBDIRECTORY_REQUIRED"
    );
  }
  throw pluginPackageError(`Plugin archive has no ${MANIFEST_NAME}.`, "PLUGIN_PACKAGE_MANIFEST_MISSING");
}

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
      let managedAlreadyPresent = false;
      for (const root of this.options.roots) {
        const existing = path.join(root, prepared.manifest.id, prepared.manifest.version);
        try {
          if (await hashPluginPackage(existing) !== prepared.revision) throw Object.assign(new Error("This plugin version already exists with different bytes. Publish a new plugin version."), { status: 409, code: "PLUGIN_PACKAGE_VERSION_CONFLICT" });
          if (path.resolve(root) === path.resolve(this.options.managedRoot)) managedAlreadyPresent = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      assertCurrent();
      if (managedAlreadyPresent) return imported;
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

  /**
   * Fetch and read a plugin archive without touching the package store, so the
   * user can review identity, version and requested capabilities before install.
   */
  async inspectUrl(url: string, signal?: AbortSignal, subdirectory?: string): Promise<RemoteArchiveInspection> {
    const staged = await this.stageRemoteArchive(url, signal);
    try {
      const candidates = await discoverPackages(path.join(staged.operationRoot, "source"), subdirectory);
      const packages: InspectedRemotePackage[] = [];
      for (const candidate of candidates) {
        const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(candidate.root, MANIFEST_NAME), "utf8")));
        const missingEntries = await collectMissingEntries(candidate.root, manifest);
        packages.push(Object.freeze({
          id: manifest.id,
          version: manifest.version,
          manifest,
          packagePath: candidate.relativePath,
          runnable: missingEntries.length === 0,
          missingEntries
        }));
      }
      if (packages.length === 0) throw pluginPackageError(`Plugin archive has no ${MANIFEST_NAME}.`, "PLUGIN_PACKAGE_MANIFEST_MISSING");
      return Object.freeze({
        archiveSha256: staged.sha256,
        archiveBytes: staged.bytes,
        sourceUrl: url,
        packages
      });
    } finally {
      await fs.rm(staged.operationRoot, { recursive: true, force: true });
    }
  }

  /**
   * Install from a URL after the caller confirms the inspected archive. The
   * expected digest fences the confirmation against a changed download.
   */
  async importUrl(url: string, assertCurrent: () => void, expectedArchiveSha256?: string, subdirectory?: string): Promise<ImportedPluginPackage> {
    const staged = await this.stageRemoteArchive(url);
    try {
      if (expectedArchiveSha256 && staged.sha256 !== expectedArchiveSha256.trim().toLowerCase()) {
        throw pluginPackageError("The plugin archive changed after it was inspected. Inspect it again before installing.", "PLUGIN_PACKAGE_ARCHIVE_CHANGED", 409);
      }
      const resolved = await resolvePackageRoot(path.join(staged.operationRoot, "source"), subdirectory);
      const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(resolved.root, MANIFEST_NAME), "utf8")));
      const missingEntries = await collectMissingEntries(resolved.root, manifest);
      if (missingEntries.length > 0) {
        throw pluginPackageError(
          `This path is plugin source rather than a built plugin package; missing built entries: ${missingEntries.slice(0, 3).join(", ")}. Build the package (npm run build) or install a published plugin package.`,
          "PLUGIN_PACKAGE_SOURCE_ONLY"
        );
      }
      return await this.importDirectory(resolved.root, assertCurrent);
    } finally {
      await fs.rm(staged.operationRoot, { recursive: true, force: true });
    }
  }

  private async stageRemoteArchive(url: string, signal?: AbortSignal): Promise<{ operationRoot: string; sha256: string; bytes: number }> {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw pluginPackageError("Plugin installation needs an absolute https URL.", "PLUGIN_PACKAGE_URL_INVALID"); }
    if (parsed.protocol !== "https:") throw pluginPackageError("Plugin installation requires an https URL.", "PLUGIN_PACKAGE_URL_INSECURE");
    const operationRoot = path.join(path.resolve(this.options.importRuntimeRoot), randomUUID());
    const source = path.join(operationRoot, "source");
    const archivePath = path.join(operationRoot, "archive");
    await fs.mkdir(operationRoot, { recursive: true });
    try {
      const response = await fetch(parsed, {
        signal: signal ?? AbortSignal.timeout(REMOTE_ARCHIVE_TIMEOUT_MS),
        redirect: "follow",
        headers: { "user-agent": "RabiRoute-PluginImport" }
      });
      if (!response.ok) throw pluginPackageError(`Plugin archive download failed with HTTP ${response.status}.`, "PLUGIN_PACKAGE_DOWNLOAD_FAILED");
      if (!response.body) throw pluginPackageError("Plugin archive download returned no content.", "PLUGIN_PACKAGE_DOWNLOAD_FAILED");
      const digest = createHash("sha256");
      const handle = await fs.open(archivePath, "w");
      let bytes = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > MAX_REMOTE_ARCHIVE_BYTES) throw pluginPackageError("Plugin archive exceeds the 64 MB import limit.", "PLUGIN_PACKAGE_TOO_LARGE", 413);
          digest.update(chunk);
          await handle.write(chunk);
        }
      } finally { await handle.close(); }
      if (bytes === 0) throw pluginPackageError("Plugin archive download produced an empty file.", "PLUGIN_PACKAGE_DOWNLOAD_FAILED");
      await extractArchive(archivePath, source);
      return { operationRoot, sha256: digest.digest("hex"), bytes };
    } catch (error) {
      await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
