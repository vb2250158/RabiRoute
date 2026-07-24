import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MESSAGE_CONTEXT_DIR, messageContextLockPath } from "./messageContextStore.js";
import {
  PersonaSyncManifestIndex,
  personaSyncFileEligible,
  type PersonaSyncManifestIndexOptions,
  type PersonaSyncManifestIndexStatus
} from "./personaSyncManifestIndex.js";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";
import { sanitizeRoleId } from "./shared/routeIdentity.js";

export const PERSONA_SYNC_DELETED_HASH = "deleted";

export type PersonaSyncFile = {
  roleId: string;
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  mergeStrategy: "jsonl-union" | "three-way-file";
};

export type PersonaSyncManifest = {
  schemaVersion: 1;
  generatedAt: string;
  roles: Array<{ roleId: string; files: PersonaSyncFile[] }>;
};

export type PersonaSyncMergeCommand = {
  roleId: string;
  path: string;
  contentBase64?: string;
  deleted?: boolean;
  remoteHash?: string;
  baseHash?: string;
  peerId?: string;
};

export type PersonaSyncMergeResult = {
  status: "created" | "fast_forwarded" | "kept_local" | "merged" | "unchanged" | "conflict";
  roleId: string;
  path: string;
  localHash?: string;
  remoteHash: string;
  resultHash?: string;
  archivePath?: string;
  conflictPath?: string;
  remoteDeleted?: boolean;
};

export type PersonaSyncConflict = {
  conflictId: string;
  roleId: string;
  path: string;
  size: number;
  createdAt: string;
  localHash?: string;
  remoteHash: string;
  remoteDeleted?: boolean;
  peerId?: string;
  baseHash?: string;
};

export type PersonaSyncConflictResolutionCommand = {
  conflictId: string;
  action: "keep_local" | "use_remote" | "use_merged";
  contentBase64?: string;
  expectedLocalHash?: string;
};

export type PersonaSyncConflictResolution = {
  status: "resolved";
  action: PersonaSyncConflictResolutionCommand["action"];
  conflictId: string;
  roleId: string;
  path: string;
  localHash?: string;
  remoteHash: string;
  remoteDeleted?: boolean;
  peerId?: string;
  baseHash?: string;
  resultHash?: string;
  archivePath?: string;
  resolutionPath: string;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 1_000) throw new Error("Persona sync path is required.");
  const segments = normalized.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Persona sync path must stay inside the persona folder.");
  }
  return segments.join("/");
}

function walkConflictFiles(root: string, current = ""): string[] {
  const directory = path.join(root, current);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkConflictFiles(root, relative);
    return entry.isFile() && !entry.name.endsWith(".meta.json")
      ? [relative.replace(/\\/g, "/")]
      : [];
  });
}

function assertNoSymbolicLinks(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Persona sync path must stay inside the persona folder.");
  }
  let current = resolvedRoot;
  const segments = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Persona sync refuses symbolic links and junctions.");
    }
  }
}

function contentLockPath(roleRoot: string, relativePath: string, target: string): string {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (normalized === MESSAGE_CONTEXT_DIR || normalized.startsWith(`${MESSAGE_CONTEXT_DIR}/`)) {
    return messageContextLockPath(roleRoot);
  }
  return `${target}.lock`;
}

function rowKey(row: Record<string, unknown>, encoded: string): string {
  for (const key of ["id", "entryId", "messageId", "deliveryId", "recordId"]) {
    const value = String(row[key] ?? "").trim();
    if (value) return `${key}:${value}`;
  }
  return `hash:${sha256(Buffer.from(encoded, "utf8"))}`;
}

function rowTime(row: Record<string, unknown>): number {
  for (const value of [row.recordedAt, row.createdAt, row.updatedAt, row.time]) {
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed > 10_000_000_000 ? parsed : parsed * 1_000;
  }
  return 0;
}

function mergeJsonl(local: Buffer, remote: Buffer): { content?: Buffer; conflict: boolean } {
  const rows = new Map<string, { row: Record<string, unknown>; encoded: string }>();
  for (const source of [local, remote]) {
    for (const line of source.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      let row: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { conflict: true };
        row = parsed as Record<string, unknown>;
      } catch {
        return { conflict: true };
      }
      const encoded = JSON.stringify(row);
      const key = rowKey(row, encoded);
      const existing = rows.get(key);
      if (existing && existing.encoded !== encoded) return { conflict: true };
      rows.set(key, { row, encoded });
    }
  }
  const merged = [...rows.values()]
    .sort((left, right) => rowTime(left.row) - rowTime(right.row) || left.encoded.localeCompare(right.encoded))
    .map(item => item.encoded)
    .join("\n");
  return { content: Buffer.from(merged ? `${merged}\n` : "", "utf8"), conflict: false };
}

export class PersonaSyncService {
  private readonly manifestIndex: PersonaSyncManifestIndex;

  constructor(
    readonly rolesRoot: () => string,
    readonly stateRoot: string,
    manifestIndexOptions: PersonaSyncManifestIndexOptions = {}
  ) {
    this.manifestIndex = new PersonaSyncManifestIndex(rolesRoot, stateRoot, manifestIndexOptions);
  }

  manifest(roleId?: string): Promise<PersonaSyncManifest> {
    return this.manifestIndex.manifest(roleId);
  }

  startManifestIndex(): Promise<void> {
    return this.manifestIndex.start();
  }

  manifestIndexStatus(): PersonaSyncManifestIndexStatus {
    return this.manifestIndex.status();
  }

  stopManifestIndex(): void {
    this.manifestIndex.stop();
  }

  readFile(roleId: string, relativePath: string): { file: PersonaSyncFile; content: Buffer } {
    const id = sanitizeRoleId(roleId);
    if (!id) throw new Error("Invalid persona id.");
    const safePath = safeRelativePath(relativePath);
    const filePath = path.join(this.rolesRoot(), id, safePath);
    const root = path.resolve(this.rolesRoot(), id);
    assertNoSymbolicLinks(root, filePath);
    if (!path.resolve(filePath).startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error("Persona sync file was not found.");
    }
    const content = fs.readFileSync(filePath);
    if (!personaSyncFileEligible(safePath, content.byteLength)) throw new Error("Persona sync file is excluded or too large.");
    const stat = fs.statSync(filePath);
    return {
      file: {
        roleId: id,
        path: safePath,
        size: content.byteLength,
        modifiedAt: stat.mtime.toISOString(),
        sha256: sha256(content),
        mergeStrategy: safePath.toLowerCase().endsWith(".jsonl") ? "jsonl-union" : "three-way-file"
      },
      content
    };
  }

  listConflicts(roleId?: string): PersonaSyncConflict[] {
    const requestedRoleId = roleId ? sanitizeRoleId(roleId) : "";
    if (roleId && !requestedRoleId) throw new Error("Invalid persona id.");
    const root = path.join(this.stateRoot, "conflicts");
    return walkConflictFiles(root).flatMap(conflictId => {
      try {
        const conflict = this.conflictEntry(conflictId);
        return !requestedRoleId || conflict.roleId === requestedRoleId ? [conflict] : [];
      } catch {
        return [];
      }
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.conflictId.localeCompare(right.conflictId));
  }

  readConflict(conflictId: string): { conflict: PersonaSyncConflict; content: Buffer } {
    const conflict = this.conflictEntry(conflictId);
    const target = path.join(this.stateRoot, "conflicts", conflict.conflictId);
    return { conflict, content: fs.readFileSync(target) };
  }

  resolveConflict(command: PersonaSyncConflictResolutionCommand): PersonaSyncConflictResolution {
    const action = String(command.action || "").trim() as PersonaSyncConflictResolutionCommand["action"];
    if (!new Set(["keep_local", "use_remote", "use_merged"]).has(action)) {
      throw new Error("Persona sync conflict action must be keep_local, use_remote, or use_merged.");
    }
    const entry = this.conflictEntry(command.conflictId);
    const conflictTarget = path.join(this.stateRoot, "conflicts", entry.conflictId);
    const target = path.join(this.rolesRoot(), entry.roleId, entry.path);
    const roleRoot = path.resolve(this.rolesRoot(), entry.roleId);
    const lockPath = path.join(this.stateRoot, "locks", entry.roleId, `${sha256(Buffer.from(entry.path, "utf8"))}.lock`);
    const resolution: PersonaSyncConflictResolution = withFileLockSync(lockPath, () =>
      withFileLockSync(contentLockPath(roleRoot, entry.path, target), () => {
        const refreshed = this.conflictEntry(entry.conflictId);
        assertNoSymbolicLinks(roleRoot, target);
        const local = fs.existsSync(target) ? fs.readFileSync(target) : null;
        const localHash = local ? sha256(local) : undefined;
        const expectedLocalHash = String(command.expectedLocalHash || "").trim() || undefined;
        if (expectedLocalHash && expectedLocalHash !== localHash) {
          throw new Error("Persona sync conflict resolution refused a stale local file hash.");
        }
        let result: Buffer | null = local;
        if (action === "use_remote") result = refreshed.remoteDeleted ? null : fs.readFileSync(conflictTarget);
        if (action === "use_merged") {
          if (typeof command.contentBase64 !== "string") throw new Error("Merged persona content is required.");
          result = Buffer.from(command.contentBase64, "base64");
        }
        if (action !== "keep_local" && result) {
          if (!personaSyncFileEligible(entry.path, result.byteLength)) throw new Error("Resolved persona file is excluded or too large.");
          if (entry.path.toLowerCase().endsWith(".jsonl")) {
            const validated = mergeJsonl(result, Buffer.alloc(0));
            if (validated.conflict || !validated.content) throw new Error("Resolved persona JSONL is invalid or contains conflicting stable ids.");
            result = validated.content;
          }
        }
        const resultHash = result ? sha256(result) : undefined;
        let archivePath: string | undefined;
        if (action !== "keep_local") {
          if (local && localHash !== resultHash) archivePath = this.archive(entry.roleId, entry.path, local);
          if (result) atomicWriteFileSync(target, result);
          else if (local) fs.rmSync(target);
        }
        const resolutionPath = this.archiveResolvedConflict(refreshed, conflictTarget, action, localHash, resultHash);
        return {
          status: "resolved",
          action,
          conflictId: refreshed.conflictId,
          roleId: refreshed.roleId,
          path: refreshed.path,
          localHash,
          remoteHash: refreshed.remoteHash,
          remoteDeleted: refreshed.remoteDeleted,
          peerId: refreshed.peerId,
          baseHash: refreshed.baseHash,
          resultHash,
          archivePath,
          resolutionPath
        };
      })
    );
    this.manifestIndex.notePathChanged(entry.roleId, entry.path);
    return resolution;
  }

  merge(command: PersonaSyncMergeCommand): PersonaSyncMergeResult {
    const roleId = sanitizeRoleId(command.roleId);
    if (!roleId) throw new Error("Invalid persona id.");
    const relativePath = safeRelativePath(command.path);
    const remoteDeleted = command.deleted === true;
    if (remoteDeleted && relativePath.toLowerCase().endsWith(".jsonl")) {
      throw new Error("Persona sync JSONL ledgers use union/tombstone semantics and cannot be deleted remotely.");
    }
    const remote = remoteDeleted ? Buffer.alloc(0) : Buffer.from(String(command.contentBase64 || ""), "base64");
    if (!remoteDeleted && !personaSyncFileEligible(relativePath, remote.byteLength)) throw new Error("Persona sync file is excluded or too large.");
    const remoteHash = remoteDeleted ? PERSONA_SYNC_DELETED_HASH : sha256(remote);
    if (command.remoteHash && command.remoteHash !== remoteHash) throw new Error("Remote persona file hash does not match its content.");
    const target = path.join(this.rolesRoot(), roleId, relativePath);
    const roleRoot = path.resolve(this.rolesRoot(), roleId);
    const lockPath = path.join(this.stateRoot, "locks", roleId, `${sha256(Buffer.from(relativePath, "utf8"))}.lock`);
    const result: PersonaSyncMergeResult = withFileLockSync(lockPath, () =>
      withFileLockSync(contentLockPath(roleRoot, relativePath, target), () => {
        assertNoSymbolicLinks(roleRoot, target);
        const local = fs.existsSync(target) ? fs.readFileSync(target) : null;
        const localHash = local ? sha256(local) : undefined;
        const baseHash = String(command.baseHash || "").trim() || undefined;
        if (remoteDeleted) {
          if (!local) {
            return {
              status: "unchanged",
              roleId,
              path: relativePath,
              remoteHash,
              remoteDeleted: true
            };
          }
          if (baseHash && localHash === baseHash) {
            const archivePath = this.archive(roleId, relativePath, local);
            fs.rmSync(target);
            return {
              status: "fast_forwarded",
              roleId,
              path: relativePath,
              localHash,
              remoteHash,
              remoteDeleted: true,
              archivePath
            };
          }
          const conflictPath = this.conflict(roleId, relativePath, remote, command.peerId, {
            remoteDeleted: true,
            remoteHash,
            baseHash
          });
          return {
            status: "conflict",
            roleId,
            path: relativePath,
            localHash,
            remoteHash,
            resultHash: localHash,
            conflictPath,
            remoteDeleted: true
          };
        }
        if (!local) {
          if (baseHash && baseHash !== PERSONA_SYNC_DELETED_HASH) {
            if (remoteHash === baseHash) {
              return { status: "kept_local", roleId, path: relativePath, remoteHash };
            }
            const conflictPath = this.conflict(roleId, relativePath, remote, command.peerId, {
              remoteHash,
              baseHash
            });
            return { status: "conflict", roleId, path: relativePath, remoteHash, conflictPath };
          }
          atomicWriteFileSync(target, remote);
          return { status: "created", roleId, path: relativePath, remoteHash, resultHash: remoteHash };
        }
        if (localHash === remoteHash) return { status: "unchanged", roleId, path: relativePath, localHash, remoteHash, resultHash: localHash };
        if (baseHash && remoteHash === baseHash) return { status: "kept_local", roleId, path: relativePath, localHash, remoteHash, resultHash: localHash };
        if (baseHash && localHash === baseHash) {
          const archivePath = this.archive(roleId, relativePath, local);
          atomicWriteFileSync(target, remote);
          return { status: "fast_forwarded", roleId, path: relativePath, localHash, remoteHash, resultHash: remoteHash, archivePath };
        }
        if (relativePath.toLowerCase().endsWith(".jsonl")) {
          const merged = mergeJsonl(local, remote);
          if (!merged.conflict && merged.content) {
            const resultHash = sha256(merged.content);
            const archivePath = this.archive(roleId, relativePath, local);
            atomicWriteFileSync(target, merged.content);
            return { status: "merged", roleId, path: relativePath, localHash, remoteHash, resultHash, archivePath };
          }
        }
        const conflictPath = this.conflict(roleId, relativePath, remote, command.peerId, { remoteHash, baseHash });
        return { status: "conflict", roleId, path: relativePath, localHash, remoteHash, resultHash: localHash, conflictPath };
      })
    );
    this.manifestIndex.notePathChanged(roleId, relativePath);
    return result;
  }

  private archive(roleId: string, relativePath: string, content: Buffer): string {
    const target = path.join(this.stateRoot, "archive", roleId, relativePath, `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha256(content).slice(0, 12)}`);
    atomicWriteFileSync(target, content);
    return path.relative(this.stateRoot, target).replace(/\\/g, "/");
  }

  private conflict(
    roleId: string,
    relativePath: string,
    content: Buffer,
    peerId?: string,
    metadata: { remoteDeleted?: boolean; remoteHash: string; baseHash?: string } = { remoteHash: sha256(content) }
  ): string {
    const peer = String(peerId || "peer").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80) || "peer";
    const evidenceHash = metadata.remoteDeleted ? PERSONA_SYNC_DELETED_HASH : sha256(content).slice(0, 12);
    const target = path.join(this.stateRoot, "conflicts", roleId, relativePath, `${new Date().toISOString().replace(/[:.]/g, "-")}-${peer}-${evidenceHash}`);
    atomicWriteFileSync(target, content);
    atomicWriteFileSync(`${target}.meta.json`, `${JSON.stringify({
      schemaVersion: 1,
      peerId: String(peerId || ""),
      remoteDeleted: metadata.remoteDeleted === true,
      remoteHash: metadata.remoteHash,
      baseHash: metadata.baseHash || ""
    }, null, 2)}\n`);
    return path.relative(this.stateRoot, target).replace(/\\/g, "/");
  }

  private conflictEntry(conflictId: string): PersonaSyncConflict {
    const safeId = safeRelativePath(conflictId).replace(/^conflicts\//, "");
    const segments = safeId.split("/");
    if (segments.length < 3) throw new Error("Invalid persona sync conflict id.");
    const roleId = sanitizeRoleId(segments[0]);
    if (!roleId || roleId !== segments[0]) throw new Error("Invalid persona sync conflict persona id.");
    const relativePath = safeRelativePath(segments.slice(1, -1).join("/"));
    const conflictsRoot = path.resolve(this.stateRoot, "conflicts");
    const target = path.join(conflictsRoot, safeId);
    assertNoSymbolicLinks(conflictsRoot, target);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("Persona sync conflict was not found.");
    const content = fs.readFileSync(target);
    let metadata: { peerId?: string; remoteDeleted?: boolean; remoteHash?: string; baseHash?: string } = {};
    try {
      metadata = JSON.parse(fs.readFileSync(`${target}.meta.json`, "utf8")) as typeof metadata;
    } catch {
      metadata = {};
    }
    const roleRoot = path.resolve(this.rolesRoot(), roleId);
    const localTarget = path.join(roleRoot, relativePath);
    assertNoSymbolicLinks(roleRoot, localTarget);
    const local = fs.existsSync(localTarget) && fs.statSync(localTarget).isFile() ? fs.readFileSync(localTarget) : null;
    const stat = fs.statSync(target);
    return {
      conflictId: safeId,
      roleId,
      path: relativePath,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      localHash: local ? sha256(local) : undefined,
      remoteHash: String(metadata.remoteHash || sha256(content)),
      remoteDeleted: metadata.remoteDeleted === true,
      peerId: String(metadata.peerId || "") || undefined,
      baseHash: String(metadata.baseHash || "") || undefined
    };
  }

  private archiveResolvedConflict(
    conflict: PersonaSyncConflict,
    conflictTarget: string,
    action: PersonaSyncConflictResolutionCommand["action"],
    localHash: string | undefined,
    resultHash: string | undefined
  ): string {
    const resolvedTarget = path.join(this.stateRoot, "resolved-conflicts", conflict.conflictId);
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    fs.renameSync(conflictTarget, resolvedTarget);
    if (fs.existsSync(`${conflictTarget}.meta.json`)) {
      fs.renameSync(`${conflictTarget}.meta.json`, `${resolvedTarget}.meta.json`);
    }
    atomicWriteFileSync(`${resolvedTarget}.resolution.json`, `${JSON.stringify({
      schemaVersion: 1,
      resolvedAt: new Date().toISOString(),
      action,
      conflictId: conflict.conflictId,
      roleId: conflict.roleId,
      path: conflict.path,
      localHash,
      remoteHash: conflict.remoteHash,
      remoteDeleted: conflict.remoteDeleted === true,
      peerId: conflict.peerId || "",
      baseHash: conflict.baseHash || "",
      resultHash
    }, null, 2)}\n`);
    return path.relative(this.stateRoot, resolvedTarget).replace(/\\/g, "/");
  }
}
