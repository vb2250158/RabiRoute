import { constants, type Stats } from "node:fs";
import { lstat, realpath, opendir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { parseRoleSkillMarkdown } from "../roleKnowledge.js";
import { isPortableSkillArchiveSegment } from "../shared/skillArchivePath.js";

export type RoleSkillArchiveLimits = {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxArchiveBytes: number;
};
export const roleSkillArchiveLimits: Readonly<RoleSkillArchiveLimits> = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxDepth: 32,
  maxArchiveBytes: 68 * 1024 * 1024
});
export class RoleSkillArchiveError extends Error {
  constructor(public readonly code: "not_found" | "unsafe_path" | "too_large" | "conflict", message: string) {
    super(message);
    this.name = "RoleSkillArchiveError";
  }
}
type Source = { filePath: string; stat: Stats };
type ArchiveEntry = Source & { zipPath: string; directory: boolean };
function fail(code: RoleSkillArchiveError["code"], message: string): never {
  throw new RoleSkillArchiveError(code, message);
}
function safeSegment(segment: string): void {
  if (!isPortableSkillArchiveSegment(segment)) fail("unsafe_path", "Unsafe archive path segment.");
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.nlink === after.nlink && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function directoryNames(filePath: string, budget: number): Promise<string[]> {
  // Bound both the application list and Node's internal directory read-ahead.
  const directory = await opendir(filePath, { bufferSize: 1 });
  const names: string[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      if (names.length >= budget) fail("too_large", "Skill directory exceeds entry limit.");
      names.push(entry.name);
    }
  } finally { await directory.close(); }
  return names.sort();
}
async function inspect(filePath: string, root?: string): Promise<Source> {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
    fail("unsafe_path", "Skill source contains a link or non-regular entry.");
  }
  const resolved = await realpath(filePath);
  if (root && !within(root, resolved)) fail("unsafe_path", "Skill source escapes its canonical root.");
  return { filePath, stat };
}
async function verify(source: Source, root?: string): Promise<void> {
  const current = await inspect(source.filePath, root);
  if (!unchanged(source.stat, current.stat)) fail("conflict", "Skill source changed during archive generation.");
}
async function openSource(source: Source, root: string): Promise<FileHandle> {
  await verify(source, root);
  const handle = await open(source.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!unchanged(source.stat, await handle.stat())) fail("conflict", "Skill source changed before opening.");
    await verify(source, root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Writes a complete, bounded ZIP to a NEW file in a caller-owned trusted lease.
 * Caller owns authorization, output parent safety and cleanup after success.
 * Source owners must be trusted: Node has no portable openat; repeated path and
 * handle checks detect ordinary changes, not every malicious ancestor race.
 * Throws RoleSkillArchiveError; never overwrites an existing output file.
 */
export async function buildRoleSkillArchive(
  roleDir: string, skillId: string, outputPath: string, limits?: Partial<RoleSkillArchiveLimits>
): Promise<{ sizeBytes: number; sha256: string; fileCount: number }> {
  const bound = { ...roleSkillArchiveLimits, ...limits };
  for (const value of Object.values(bound)) {
    if (!Number.isSafeInteger(value) || value < 0) fail("too_large", "Archive limits must be nonnegative safe integers.");
  }
  safeSegment(skillId);
  const snapshots = new Map<string, Source>();
  const ancestors: Source[] = [];
  const remember = (source: Source): Source => {
    const before = snapshots.get(source.filePath);
    if (before && !unchanged(before.stat, source.stat)) fail("conflict", "Skill source changed during selection.");
    snapshots.set(source.filePath, source);
    return source;
  };
  let output: FileHandle | undefined;
  let created = false;
  let started = false;
  let zip: ZipFile | undefined;
  let archiveStream: Readable | undefined;
  const active = new Set<Readable>();
  try {
    const absoluteRole = path.resolve(roleDir);
    // Inspect every existing ancestor, including the skills root itself: realpath
    // alone would silently accept a junction as the canonical root.
    const skillsPath = path.join(absoluteRole, "skills");
    const parsed = path.parse(skillsPath);
    let cursor = parsed.root;
    for (const segment of skillsPath.slice(parsed.root.length).split(path.sep)) {
      cursor = path.join(cursor, segment);
      const source = await inspect(cursor);
      if (!source.stat.isDirectory()) fail("unsafe_path", "Skill root ancestor is not a directory.");
      // Ancestors may have unrelated siblings changed by the caller's output lease.
      if (cursor === skillsPath) remember(source);
      else ancestors.push(source);
    }
    const root = await realpath(skillsPath);
    started = true;
    const rootNames = await directoryNames(root, bound.maxEntries);
    let metadataBytes = 0;
    const candidates: { id: string; entry: Source; folder?: Source; stem: string }[] = [];
    for (const name of rootNames) {
      safeSegment(name);
      const source = remember(await inspect(path.join(root, name), root));
      let entry: Source;
      let folder: Source | undefined;
      if (source.stat.isDirectory()) {
        folder = source;
        try { entry = remember(await inspect(path.join(source.filePath, "SKILL.md"), root)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      } else {
        if (!name.endsWith(".md")) continue;
        entry = source;
      }
      if (!entry.stat.isFile()) fail("unsafe_path", "Skill entry is not a regular file.");
      metadataBytes += entry.stat.size;
      if (entry.stat.size > bound.maxFileBytes || metadataBytes > bound.maxTotalBytes) fail("too_large", "Skill entry metadata exceeds limits.");
      const handle = await openSource(entry, root);
      let raw: Buffer;
      try {
        // Bounded allocation; a concurrently growing entry cannot turn readFile
        // into an unbounded allocation.
        raw = Buffer.alloc(entry.stat.size);
        let offset = 0;
        while (offset < raw.length) {
          const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
          if (!bytesRead) fail("conflict", "Skill entry became shorter.");
          offset += bytesRead;
        }
        if (!unchanged(entry.stat, await handle.stat())) fail("conflict", "Skill entry changed while reading.");
        await verify(entry, root);
      } finally { await handle.close(); }
      const id = parseRoleSkillMarkdown(raw.toString("utf8"), entry.filePath, () => entry.stat.mtime.toISOString())?.id;
      if (id) candidates.push({ id, entry, folder, stem: folder ? name : name.slice(0, -3) });
    }
    const matches = candidates.filter(candidate => candidate.id === skillId);
    if (matches.length > 1) fail("conflict", "Multiple skill entries have the requested id.");
    if (!matches.length) fail("not_found", "Skill was not found.");
    const selected = matches[0];
    if (candidates.some(candidate => candidate !== selected && candidate.stem.toLowerCase() === selected.stem.toLowerCase())) {
      fail("conflict", "Flat and directory skill entries conflict.");
    }
    const entries: ArchiveEntry[] = [];
    const zipNames = new Set<string>();
    let totalBytes = 0;
    const add = (source: Source, zipPath: string, depth: number): void => {
      if (depth > bound.maxDepth || entries.length + 1 > bound.maxEntries) fail("too_large", "Skill tree exceeds entry or depth limit.");
      const key = zipPath.normalize("NFC").toLowerCase();
      if (zipNames.has(key)) fail("conflict", "Archive names collide on portable filesystems.");
      zipNames.add(key);
      if (source.stat.isFile()) {
        totalBytes += source.stat.size;
        if (source.stat.size > bound.maxFileBytes || totalBytes > bound.maxTotalBytes) fail("too_large", "Skill contents exceed byte limits.");
      }
      entries.push({ ...source, zipPath, directory: source.stat.isDirectory() });
    };
    let pendingNames = 0;
    const walk = async (folder: Source, prefix: string, depth: number): Promise<void> => {
      add(folder, prefix, depth);
      // Reserve names already collected from ancestors, not just entries added
      // to the ZIP, so nested scans share the same remaining entry budget.
      const names = await directoryNames(folder.filePath, bound.maxEntries - entries.length - pendingNames);
      pendingNames += names.length;
      for (const name of names) {
        pendingNames -= 1;
        safeSegment(name);
        const source = remember(await inspect(path.join(folder.filePath, name), root));
        const zipPath = `${prefix}/${name}`;
        if (source.stat.isDirectory()) await walk(source, zipPath, depth + 1);
        else add(source, zipPath, depth + 1);
      }
      await verify(folder, root);
    };
    if (selected.folder) await walk(selected.folder, skillId, 0);
    else {
      add(remember(await inspect(root, root)), skillId, 0);
      add(selected.entry, `${skillId}/SKILL.md`, 1);
    }
    // Prevent a caller mistake from creating the archive inside its own source.
    if (within(root, path.resolve(outputPath))) fail("unsafe_path", "Archive output must be outside the skills root.");
    output = await open(outputPath, "wx", 0o600);
    created = true;
    zip = new ZipFile();
    if (!(zip.outputStream instanceof Readable)) fail("conflict", "ZIP library did not provide a Node readable stream.");
    archiveStream = zip.outputStream;
    let sizeBytes = 0;
    let readBytes = 0;
    const hash = createHash("sha256");
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > bound.maxArchiveBytes) return callback(new RoleSkillArchiveError("too_large", "ZIP exceeds archive byte limit."));
      hash.update(chunk);
      callback(null, chunk);
    } });
    zip.on("error", error => archiveStream?.destroy(error));
    const writing = pipeline(archiveStream, meter, output.createWriteStream());
    // Observe pipeline rejection immediately while lazy source readers are active.
    void writing.catch(error => {
      zip?.emit("error", error);
      for (const stream of active) stream.destroy();
    });
    for (const entry of entries) {
      if (entry.directory) { zip.addEmptyDirectory(entry.zipPath, { mtime: entry.stat.mtime }); continue; }
      zip.addReadStreamLazy(entry.zipPath, { size: entry.stat.size, mtime: entry.stat.mtime, mode: entry.stat.mode }, callback => {
        const stream = Readable.from((async function* () {
          const handle = await openSource(entry, root);
          let position = 0;
          try {
            while (position < entry.stat.size) {
              const buffer = Buffer.alloc(Math.min(64 * 1024, entry.stat.size - position));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
              if (!bytesRead) fail("conflict", "Skill file became shorter.");
              position += bytesRead;
              readBytes += bytesRead;
              if (position > bound.maxFileBytes || readBytes > bound.maxTotalBytes) fail("too_large", "Skill stream exceeds byte limits.");
              yield buffer.subarray(0, bytesRead);
            }
            if (!unchanged(entry.stat, await handle.stat())) fail("conflict", "Skill file changed while streaming.");
            await verify(entry, root);
          } finally { await handle.close(); }
        })());
        active.add(stream);
        stream.once("error", error => zip?.emit("error", error));
        stream.once("close", () => active.delete(stream));
        callback(null, stream);
      });
    }
    zip.end();
    await writing;
    for (const source of snapshots.values()) await verify(source, root);
    for (const before of ancestors) {
      const after = await inspect(before.filePath);
      if (before.stat.dev !== after.stat.dev || before.stat.ino !== after.stat.ino || before.stat.mode !== after.stat.mode) {
        fail("conflict", "Skill root ancestor changed.");
      }
    }
    if ((await directoryNames(root, bound.maxEntries)).join("\0") !== rootNames.join("\0")) fail("conflict", "Skill catalog changed.");
    await output.close();
    output = undefined;
    return { sizeBytes, sha256: hash.digest("hex"), fileCount: entries.filter(entry => !entry.directory).length };
  } catch (error) {
    archiveStream?.destroy();
    const closing = [...active].map(stream => {
      stream.destroy();
      return finished(stream).catch(() => undefined);
    });
    await Promise.all(closing);
    let cleanupFailed = false;
    if (output) await output.close().catch(() => { cleanupFailed = true; });
    if (created) await unlink(outputPath).catch(cleanupError => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true;
    });
    if (cleanupFailed) fail("conflict", "Archive cleanup failed; the caller must remove its output lease.");
    if (error instanceof RoleSkillArchiveError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail(started ? "conflict" : "not_found", "Skill source or output parent is missing.");
    if (code === "ELOOP") fail("unsafe_path", "Skill source contains a symbolic link.");
    fail("conflict", "Skill archive could not be completed.");
  }
}
