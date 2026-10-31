import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type WebPatchFile = { path: string; sha256: string; size: number };
export type WebPatchManifest = {
  schemaVersion: 1;
  backend: string;
  files: WebPatchFile[];
  modules: { pluginId: string; version: string; entry: string }[];
};
export const WEB_PATCH_HASH = /^[a-f0-9]{64}$/;
export const WEB_PATCH_PREFIX = "/_rabiroute/web/";
const maximumBytes = 128 * 1024 * 1024;

export function webPatchHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function webPatchPath(value: string): string {
  if (typeof value !== "string" || !/^(web|docs)\/[A-Za-z0-9_./\-\u0080-\uffff]+$/.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith("."))) throw new Error("Invalid Web patch path.");
  return value;
}

async function walk(root: string, prefix = "", excluded: string[] = [], signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excluded.some(name => relative === name || relative.startsWith(name + "/"))) continue;
    if (entry.isDirectory()) result.push(...await walk(root, relative, excluded, signal));
    else if (entry.isFile()) result.push(relative);
    if (result.length > 8192) throw new Error("Web patch input has too many files.");
  }
  return result.sort();
}

async function fileHash(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function webPatchBackend(packageRoot: string, signal?: AbortSignal): Promise<string> {
  const root = path.join(packageRoot, "dist");
  const files = (await walk(root, "", ["web-patches", "agent-hooks"], signal)).filter(file => /\.(js|mjs|json)$/.test(file)
    && !file.endsWith(".test.js") && !file.includes("/web/") && !file.startsWith("agent-hooks/") && !file.startsWith("web-patches/"));
  const hashes = new Array<string>(files.length);
  let nextFile = 0;
  let failure: [] | [unknown] = [];
  const hashFiles = async () => {
    while (!failure.length && nextFile < files.length) {
      const index = nextFile++;
      try {
        signal?.throwIfAborted();
        hashes[index] = await fileHash(path.join(root, files[index]!), signal);
      } catch (error) {
        if (!failure.length) failure = [error];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, hashFiles));
  if (failure.length) throw failure[0];
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  // Completion order does not change the existing sorted backend fingerprint.
  for (let index = 0; index < files.length; index++) hash.update(`${files[index]}\0${hashes[index]}\n`);
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await fs.readFile(path.join(packageRoot, name), { signal }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    hash.update(`${name}\0${bytes ? webPatchHash(bytes) : "absent"}\n`);
  }
  return hash.digest("hex");
}

export async function writeWebPatchJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

async function readWebPatchManifest(root: string, expected: string, signal?: AbortSignal): Promise<WebPatchManifest> {
  signal?.throwIfAborted();
  if (!WEB_PATCH_HASH.test(expected)) throw new Error("Invalid Web patch hash.");
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
  const manifestStat = await fs.lstat(path.join(root, "manifest.json"));
  if (manifestStat.isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
  if (!manifestStat.isFile() || manifestStat.size > 2 * 1024 * 1024) throw new Error("Web patch manifest hash mismatch.");
  const raw = await fs.readFile(path.join(root, "manifest.json"), { signal });
  if (raw.length > 2 * 1024 * 1024 || webPatchHash(raw) !== expected) throw new Error("Web patch manifest hash mismatch.");
  const manifest = JSON.parse(raw.toString()) as WebPatchManifest;
  if (manifest.schemaVersion !== 1 || !WEB_PATCH_HASH.test(manifest.backend) || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > 8192 || !Array.isArray(manifest.modules) || manifest.modules.length > 128) throw new Error("Invalid Web patch manifest.");
  const names = new Set<string>();
  const portableNames = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    webPatchPath(file.path);
    if (portableNames.has(file.path.toLowerCase()) || !WEB_PATCH_HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid Web patch file record.");
    names.add(file.path);
    portableNames.add(file.path.toLowerCase());
    bytes += file.size;
    if (bytes > maximumBytes || file.size > 16 * 1024 * 1024) throw new Error("Web patch exceeds its byte budget.");
  }
  if (!names.has("web/index.html") || !manifest.files.some(file => file.path.startsWith("docs/"))) throw new Error("Web patch requires a root document and versioned documentation.");
  const moduleIds = new Set<string>();
  for (const module of manifest.modules) {
    const id = `${module.pluginId}@${module.version}`;
    if (typeof module.pluginId !== "string" || typeof module.version !== "string" || moduleIds.has(id)
      || !module.entry.startsWith("web/assets/") || !names.has(module.entry)) throw new Error("Invalid Web Bundle entry.");
    moduleIds.add(id);
  }
  return manifest;
}

async function verifyWebPatchFiles(root: string, manifest: WebPatchManifest, signal?: AbortSignal): Promise<WebPatchManifest> {
  const names = new Set(manifest.files.map(file => file.path));
  // Validate the whole manifest before starting any file work. Each worker keeps
  // all ancestor, containment, size and content checks local to this verification.
  const realRoot = await fs.realpath(root);
  let nextFile = 0;
  let failure: [] | [unknown] = [];
  const verifyFiles = async () => {
    while (!failure.length && nextFile < manifest.files.length) {
      const file = manifest.files[nextFile++]!;
      try {
        signal?.throwIfAborted();
        const filename = await fs.realpath(path.join(root, file.path));
        let ancestor = root;
        for (const segment of file.path.split("/")) {
          ancestor = path.join(ancestor, segment);
          if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error("Web patch inputs cannot contain symbolic links.");
        }
        if (!filename.startsWith(realRoot + path.sep) || (await fs.lstat(path.join(root, file.path))).isSymbolicLink()
          || (await fs.stat(filename)).size !== file.size || await fileHash(filename, signal) !== file.sha256) throw new Error("Web patch file verification failed.");
      } catch (error) {
        if (!failure.length) failure = [error];
      }
    }
  };
  // At most eight files/hash streams are live. A failure stops new claims, but
  // the caller still joins every started worker before receiving the original error.
  await Promise.all(Array.from({ length: Math.min(8, manifest.files.length) }, verifyFiles));
  if (failure.length) throw failure[0];
  signal?.throwIfAborted();
  const html = await fs.readFile(path.join(root, "web/index.html"), { encoding: "utf8", signal });
  for (const match of html.matchAll(/(?:src|href)=["']((?:\.\/|\/)?assets\/[^"']+)["']/g)) {
    const target = `web/${match[1]!.replace(/^\.?\//, "").split(/[?#]/)[0]}`;
    if (!names.has(target)) throw new Error(`Web root references a missing asset: ${target}`);
  }
  return manifest;
}

export async function verifyWebPatch(root: string, expected: string, signal?: AbortSignal): Promise<WebPatchManifest> {
  return verifyWebPatchFiles(root, await readWebPatchManifest(root, expected, signal), signal);
}

/** Admission for one backend's verified manifest records; foreign/unknown history remains untouched. */
export async function admitWebPatchCandidate(outputRoot: string, backend: string, revision: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const destination = path.join(outputRoot, revision);
  const existing = await fs.lstat(destination).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  // Reusing callers retain their ordinary full destination verification.
  if (existing) return;
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  let records = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isDirectory() || entry.isSymbolicLink() || !WEB_PATCH_HASH.test(entry.name)) continue;
    const candidate = path.join(outputRoot, entry.name);
    try {
      const manifest = await readWebPatchManifest(candidate, entry.name, signal);
      if (manifest.backend !== backend) continue;

    } catch {
      signal?.throwIfAborted();
      continue;
    }
    if (++records >= 64) throw new Error("Web revision retention limit reached; retain current service and review old revisions offline.");
  }
}

export async function buildWebPatch(packageRoot: string, outputRoot: string, signal?: AbortSignal): Promise<string> {
  const temporary = path.join(outputRoot, `.staging-${randomUUID()}`);
  const manifest: WebPatchManifest = { schemaVersion: 1, backend: await webPatchBackend(packageRoot, signal), files: [], modules: [] };
  signal?.throwIfAborted();
  await fs.mkdir(temporary, { recursive: true });
  try {
    const inputs: { origin: string; record: WebPatchFile }[] = [];
    const names = new Set<string>();
    for (const [source, destination] of [["ribiwebgui/dist", "web"], ["assets", "web/assets"], ["docs", "docs"]]) {
      for (const relative of await walk(path.join(packageRoot, source!), "", [], signal)) {
        signal?.throwIfAborted();
        const name = webPatchPath(`${destination}/${relative}`);
        if (names.has(name)) continue;
        names.add(name);
        inputs.push({ origin: path.join(packageRoot, source!, relative), record: { path: name, size: 0, sha256: "" } });
      }
    }
    let nextFile = 0;
    let failure: [] | [unknown] = [];
    const readSizes = async () => {
      while (!failure.length && nextFile < inputs.length) {
        const input = inputs[nextFile++]!;
        try {
          signal?.throwIfAborted();
          input.record.size = (await fs.stat(input.origin)).size;
        } catch (error) {
          if (!failure.length) failure = [error];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, inputs.length) }, readSizes));
    if (failure.length) throw failure[0];
    let bytes = 0;
    // Reserve the whole batch in source precedence order before copying anything.
    for (const input of inputs) {
      signal?.throwIfAborted();
      bytes += input.record.size;
      if (input.record.size > maximumBytes || bytes > maximumBytes) throw new Error("Web patch exceeds its byte budget.");
    }
    nextFile = 0;
    const copyFiles = async () => {
      while (!failure.length && nextFile < inputs.length) {
        const input = inputs[nextFile++]!;
        try {
          signal?.throwIfAborted();
          const target = path.join(temporary, input.record.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          signal?.throwIfAborted();
          await fs.copyFile(input.origin, target);
          signal?.throwIfAborted();
          input.record.sha256 = await fileHash(target, signal);
        } catch (error) {
          if (!failure.length) failure = [error];
        }
      }
    };
    // A failed/cancelled lane stops new claims; all claimed file I/O is joined.
    await Promise.all(Array.from({ length: Math.min(8, inputs.length) }, copyFiles));
    if (failure.length) throw failure[0];
    signal?.throwIfAborted();
    manifest.files = inputs.map(input => input.record);
    const packages = path.join(packageRoot, "dist/plugins/packages");
    for (const name of await walk(packages, "", [], signal)) {
      signal?.throwIfAborted();
      if (!name.endsWith("/rabi.plugin.json")) continue;
      const pluginRoot = path.dirname(path.join(packages, name));
      const plugin = JSON.parse(await fs.readFile(path.join(packages, name), { encoding: "utf8", signal }));
      const entry = plugin.entries?.web?.module;
      if (!entry) continue;
      const entryPath = path.join(pluginRoot, entry);
      const source = await fs.readFile(entryPath, { encoding: "utf8", signal }).catch(error => {
        if (error.code === "ENOENT") throw new Error(`Web Bundle entry is missing: ${plugin.id}. Run the complete Web build before publishing.`);
        throw error;
      });
      const match = source.match(/^export \{ activate \} from "\/(assets\/[A-Za-z0-9._/-]+)";\s*$/);
      if (!match) throw new Error(`Web Bundle wrapper is not supported: ${plugin.id}`);
      manifest.modules.push({ pluginId: plugin.id, version: plugin.version, entry: `web/${match[1]}` });
    }
    manifest.files.sort((left, right) => left.path.localeCompare(right.path));
    manifest.modules.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    const raw = JSON.stringify(manifest);
    const revision = webPatchHash(raw);
    await fs.writeFile(path.join(temporary, "manifest.json"), raw, { signal });
    await verifyWebPatch(temporary, revision, signal);
    signal?.throwIfAborted();
    const destination = path.join(outputRoot, revision);
    try { await fs.rename(temporary, destination); }
    catch (error) {
      if (!await fs.stat(destination).catch(() => undefined)) throw error;
      await verifyWebPatch(destination, revision, signal);
    }
    return revision;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
