import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 1_200;
const PACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const TRANSIENT_FS_CODES = new Set(["EMFILE", "ENFILE", "EBUSY"]);

function fileSystemErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function retryTransientFileOperation<T>(
  operation: () => T,
  options: { retries?: number; retryDelayMs?: number; wait?: (milliseconds: number) => void } = {},
): T {
  const retries = Math.max(0, Math.trunc(options.retries ?? 8));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 75));
  const wait = options.wait ?? waitSynchronously;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(fileSystemErrorCode(error)) || attempt >= retries) throw error;
      wait(Math.min(500, retryDelayMs * (attempt + 1)));
    }
  }
}

function removeDirectoryBestEffort(directory: string): void {
  try {
    retryTransientFileOperation(() => fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }));
  } catch {
    // A failed import must retain its original error. A later import can reuse a fresh local staging directory.
  }
}

type RenameDirectory = (source: fs.PathLike, destination: fs.PathLike) => void;

function copyDirectoryWithManifestLast(source: string, destination: string): void {
  retryTransientFileOperation(() => fs.mkdirSync(destination, { recursive: false }));
  const copyEntries = (from: string, to: string, root: boolean): void => {
    const entries = retryTransientFileOperation(() => fs.readdirSync(from, { withFileTypes: true }));
    for (const entry of entries) {
      if (root && entry.name.toLowerCase() === "pet-pack.json") continue;
      const sourcePath = path.join(from, entry.name);
      const destinationPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        retryTransientFileOperation(() => fs.mkdirSync(destinationPath, { recursive: false }));
        copyEntries(sourcePath, destinationPath, false);
      } else if (entry.isFile()) {
        retryTransientFileOperation(() => fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL));
      } else {
        throw new Error(`Unsupported desktop pet staging entry: ${entry.name}`);
      }
    }
  };
  copyEntries(source, destination, true);
  retryTransientFileOperation(() => fs.copyFileSync(
      path.join(source, "pet-pack.json"),
      path.join(destination, "pet-pack.json"),
      fs.constants.COPYFILE_EXCL,
    ));
}

export function commitDesktopPetPackDirectory(
  source: string,
  destination: string,
  renameDirectory: RenameDirectory = fs.renameSync,
): void {
  if (source.startsWith("\\\\")) {
    copyDirectoryWithManifestLast(source, destination);
    return;
  }
  try {
    renameDirectory(source, destination);
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (!new Set(["EACCES", "EPERM", "EXDEV"]).has(code)) throw error;
    copyDirectoryWithManifestLast(source, destination);
  }
}

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  directory: boolean;
};

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error("Archive contains an absolute path.");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) throw new Error("Archive contains a path traversal entry.");
  return parts.join("/");
}

function zipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Desktop pet archive is too large.");
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Desktop pet ZIP has no central directory.");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || centralOffset + centralSize > buffer.length) throw new Error("Desktop pet ZIP directory is invalid or too large.");
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Desktop pet ZIP entry is invalid.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    const name = safeRelativePath(rawName);
    const directory = rawName.endsWith("/");
    const unixMode = externalAttributes >>> 16;
    if ((flags & 1) !== 0) throw new Error("Encrypted desktop pet archives are not supported.");
    if (!directory && method !== 0 && method !== 8) throw new Error("Desktop pet ZIP uses an unsupported compression method.");
    if ((unixMode & 0xf000) === 0xa000) throw new Error("Desktop pet ZIP may not contain symbolic links.");
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES || compressedSize > MAX_ARCHIVE_BYTES) throw new Error("Desktop pet ZIP expands beyond the safety limit.");
    entries.push({ name, method, compressedSize, size, localOffset, directory });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryPayload(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error("Desktop pet ZIP local entry is invalid.");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error("Desktop pet ZIP entry is truncated.");
  const compressed = buffer.subarray(start, end);
  const payload = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: entry.size });
  if (payload.length !== entry.size) throw new Error("Desktop pet ZIP entry size does not match its directory.");
  return payload;
}

function manifestFrom(buffer: Buffer): Record<string, unknown> {
  const value = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pet-pack.json must be an object.");
  return value as Record<string, unknown>;
}

function assertImportRoot(roleDir: string, candidate: string): void {
  const root = path.resolve(roleDir, "desktop-pet");
  const relative = path.relative(root, path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Desktop pet import escaped its persona directory.");
}

function assertStagingRoot(stagingRoot: string, candidate: string): void {
  const relative = path.relative(path.resolve(stagingRoot), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Desktop pet import escaped its staging directory.");
}

export function desktopPetImportStagingRoot(roleDir: string, tempRoot = os.tmpdir()): string {
  const windowsPath = roleDir.replace(/\//g, "\\");
  return windowsPath.startsWith("\\\\")
    ? path.join(tempRoot, "rabiroute-desktop-pet-imports")
    : path.join(roleDir, "desktop-pet", ".imports");
}

export function importDesktopPetPack(
  roleId: string,
  roleDir: string,
  fileName: string,
  contentType: string,
  payload: Buffer,
  options: { packId?: string; state?: string; name?: string } = {}
): string {
  const desktopPetRoot = path.join(roleDir, "desktop-pet");
  const packsRoot = path.join(desktopPetRoot, "packs");
  const importsRoot = desktopPetImportStagingRoot(roleDir);
  fs.mkdirSync(importsRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(importsRoot, "pack-"));
  assertStagingRoot(importsRoot, staging);
  let finalDir = "";
  try {
    const extension = path.extname(fileName).toLowerCase();
    let manifestDir = staging;
    if (contentType.includes("zip") || extension === ".zip") {
      const entries = zipEntries(payload);
      for (const entry of entries) {
        const target = path.resolve(staging, entry.name);
        const relative = path.relative(staging, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Archive entry escaped the import directory.");
        if (entry.directory) fs.mkdirSync(target, { recursive: true });
        else {
          const ext = path.extname(target).toLowerCase();
          if (!new Set([".json", ".gif", ".png"]).has(ext)) throw new Error(`Unsupported desktop pet archive file: ${entry.name}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entryPayload(payload, entry));
        }
      }
      const manifests = entries.filter(entry => !entry.directory && path.basename(entry.name).toLowerCase() === "pet-pack.json");
      if (manifests.length !== 1) throw new Error("Desktop pet ZIP must contain exactly one pet-pack.json.");
      manifestDir = path.dirname(path.join(staging, manifests[0]!.name));
    } else if (contentType.includes("gif") || extension === ".gif" || contentType.includes("png") || extension === ".png") {
      const packId = String(options.packId || "").trim();
      const state = String(options.state || "idle").trim();
      if (!PACK_ID.test(packId) || !/^[a-z][a-z0-9_-]{0,39}$/i.test(state)) throw new Error("A valid packId and state are required for a single image import.");
      const isGif = contentType.includes("gif") || extension === ".gif";
      if (isGif && payload.subarray(0, 6).toString("ascii") !== "GIF87a" && payload.subarray(0, 6).toString("ascii") !== "GIF89a") {
        throw new Error("Desktop pet GIF signature is invalid.");
      }
      if (!isGif && !payload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("Desktop pet PNG signature is invalid.");
      }
      const assetName = `${state}.${isGif ? "gif" : "png"}`;
      fs.writeFileSync(path.join(staging, assetName), payload);
      fs.writeFileSync(path.join(staging, "pet-pack.json"), JSON.stringify({
        schemaVersion: 1,
        id: packId,
        name: String(options.name || packId).trim().slice(0, 120) || packId,
        personaId: roleId,
        canvas: { width: 512, height: 512, anchorX: 0.5, anchorY: 0.96 },
        defaults: { fps: 12, scale: 0.5, loop: true },
        states: {
          idle: isGif
            ? { type: "gif", source: assetName }
            : { type: "png-sequence", source: "frames", pattern: `${state}_*.png` },
          ...(state === "idle" ? {} : { [state]: isGif
            ? { type: "gif", source: assetName }
            : { type: "png-sequence", source: "frames", pattern: `${state}_*.png` } })
        }
      }, null, 2), "utf8");
      if (!isGif) {
        fs.mkdirSync(path.join(staging, "frames"), { recursive: true });
        fs.renameSync(path.join(staging, assetName), path.join(staging, "frames", `${state}_0001.png`));
      }
    } else {
      throw new Error("Only GIF, PNG, or ZIP desktop pet imports are supported.");
    }

    const manifest = manifestFrom(fs.readFileSync(path.join(manifestDir, "pet-pack.json")));
    const packId = String(manifest.id || "").trim();
    if (!PACK_ID.test(packId) || manifest.personaId !== roleId) throw new Error("Desktop pet manifest id or personaId is invalid.");
    fs.mkdirSync(packsRoot, { recursive: true });
    finalDir = path.join(packsRoot, packId);
    assertImportRoot(roleDir, finalDir);
    if (fs.existsSync(finalDir)) throw new Error("A desktop pet pack with this id already exists.");
    commitDesktopPetPackDirectory(manifestDir, finalDir);
    return packId;
  } catch (error) {
    if (finalDir && fs.existsSync(finalDir)) removeDirectoryBestEffort(finalDir);
    throw error;
  } finally {
    if (fs.existsSync(staging)) removeDirectoryBestEffort(staging);
  }
}
