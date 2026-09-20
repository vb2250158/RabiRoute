import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type PeerPersonaManifestFile = {
  roleId: string;
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  mergeStrategy: "jsonl-union" | "three-way-file";
};

/** Wire-compatible with the persona manifest v1 contract, without importing its writable owner. */
export type PeerPersonaManifest = {
  schemaVersion: 1;
  generatedAt: string;
  roles: Array<{ roleId: string; files: PeerPersonaManifestFile[] }>;
};

const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Keep the v1 portable inventory exclusions here: importing the old index loads writable storage.
const EXCLUDED_DIRECTORIES = [
  "state/work-cycle-history", "state/work-cycle-history-locks", "state/work-cycle-inputs",
  "state/work-cycle-plan-locks", "state/work-cycle-receipt-locks", "conversation/situations",
  "plans/items", "plans/history", "plans/feedback", "plans/attachments", "plans/quarantine",
  "plans/.staging", "voice/cache/tts-audio"
];

function eligible(relative: string): boolean {
  const normalized = relative.toLowerCase();
  const segments = normalized.split("/");
  return relative.length <= 1_000
    && !segments.some(segment => !segment || segment.startsWith(".") || segment === "tmp" || segment === "temp")
    && !/\.(?:tmp|lock|part)$/i.test(normalized)
    && !/^plans\/archive\/[^/]+\.json$/i.test(normalized)
    && !EXCLUDED_DIRECTORIES.some(directory => normalized === directory || normalized.startsWith(`${directory}/`));
}

function assertChild(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("peer_persona_path_denied");
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Check every ancestor, including those above rolesRoot: junctions cannot redefine the allowed root. */
async function checkedDirectory(directory: string): Promise<fs.Stats> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  let stat = await fs.promises.lstat(current);
  for (const segment of ["", ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (segment) {
      current = path.join(current, segment);
      stat = await fs.promises.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("peer_persona_directory_denied");
  }
  return stat;
}

async function readFileEntry(
  roleRoot: string, roleId: string, relative: string, before: fs.Stats
): Promise<PeerPersonaManifestFile> {
  const target = path.join(roleRoot, ...relative.split("/"));
  const parent = path.dirname(target);
  await checkedDirectory(parent);
  assertChild(roleRoot, await fs.promises.realpath(target));
  // O_NOFOLLOW covers the final component on supporting platforms; identity checks also cover Windows.
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || !sameFile(before, opened)) {
      throw new Error("peer_persona_file_changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) throw new Error("peer_persona_file_changed");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    await checkedDirectory(parent);
    assertChild(roleRoot, await fs.promises.realpath(target));
    const named = await fs.promises.lstat(target);
    if (named.isSymbolicLink() || !sameFile(opened, after) || !sameFile(after, named) || size !== after.size) {
      throw new Error("peer_persona_file_changed");
    }
    return {
      roleId, path: relative, size, modifiedAt: after.mtime.toISOString(), sha256: hash.digest("hex"),
      mergeStrategy: relative.toLowerCase().endsWith(".jsonl") ? "jsonl-union" : "three-way-file"
    };
  } finally {
    await handle.close();
  }
}

/**
 * Fresh, read-only v1 file inventory for peer.persona.manifest.
 * The caller MUST authorize roleId against its current roleIds allowlist first.
 * No cache, watcher, lease, migration, plan validation/repair, or filesystem writes.
 * Missing roles return roles: []; unsafe paths and concurrent changes reject the request.
 * Nested symlinks/junctions are omitted (v1 behavior); linked roots/ancestors are rejected.
 * This is an inventory, not an atomic multi-file snapshot or a plan-package validator.
 * Filesystem ownership must exclude hostile concurrent rename/mount operations: Node has no
 * portable directory-handle-relative open primitive to eliminate every ancestor TOCTOU race.
 */
export async function readPeerPersonaManifest(rolesRoot: string, roleId: string): Promise<PeerPersonaManifest> {
  if (typeof roleId !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(roleId)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(roleId)) {
    throw new Error("peer_role_denied");
  }
  if (typeof rolesRoot !== "string" || !rolesRoot.trim()) throw new Error("peer_persona_root_denied");
  const root = path.resolve(rolesRoot);
  const roleRoot = path.resolve(root, roleId);
  assertChild(root, roleRoot);
  const files: PeerPersonaManifestFile[] = [];
  const manifest = (): PeerPersonaManifest => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), roles: [] });
  let roleStat: fs.Stats;
  try {
    await checkedDirectory(root);
    roleStat = await checkedDirectory(roleRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return manifest();
    throw error;
  }
  const canonicalRoot = await fs.promises.realpath(root);
  const canonicalRole = await fs.promises.realpath(roleRoot);
  assertChild(canonicalRoot, canonicalRole);

  async function visit(directory: string, relativeDirectory = ""): Promise<void> {
    const before = await checkedDirectory(directory);
    if (directory !== roleRoot) assertChild(canonicalRole, await fs.promises.realpath(directory));
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Reject non-portable names rather than converting a literal backslash/ADS into a path.
      if (/[\\/:\x00-\x1f]/.test(entry.name) || /[. ]$/.test(entry.name)) throw new Error("peer_persona_path_denied");
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!eligible(relative) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      assertChild(roleRoot, target);
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await visit(target, relative);
      else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        files.push(await readFileEntry(roleRoot, roleId, relative, stat));
      }
    }
    const after = await checkedDirectory(directory);
    if (!sameFile(before, after)) throw new Error("peer_persona_directory_changed");
  }

  await visit(roleRoot);
  if (!sameFile(roleStat, await checkedDirectory(roleRoot))) throw new Error("peer_persona_directory_changed");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { ...manifest(), roles: [{ roleId, files }] };
}
