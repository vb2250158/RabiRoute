import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PersonaSyncFile, PersonaSyncManifest } from "./personaSync.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { sanitizeRoleId } from "./shared/routeIdentity.js";

const INDEX_SCHEMA_VERSION = 1;
const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024;
const FILE_EVENT_SETTLE_MS = 80;
const FILE_EVENT_BARRIER_MS = 50;
const INDEX_PERSIST_SETTLE_MS = 120;
const HASH_CONCURRENCY = 4;

type CachedPersonaSyncFile = PersonaSyncFile & {
  mtimeMs: number;
  ctimeMs: number;
  fileId: string;
};

type PersistedManifestIndex = {
  schemaVersion: 1;
  generatedAt: string;
  roles: string[];
  files: CachedPersonaSyncFile[];
};

export type PersonaSyncManifestIndexEvent = {
  kind: "ready" | "created" | "updated" | "deleted" | "reconciled" | "watch_unavailable";
  roleId?: string;
  path?: string;
  generation: number;
};

export type PersonaSyncManifestIndexStatus = {
  state: "idle" | "initializing" | "ready" | "fallback" | "failed" | "stopped";
  watchMode: "recursive" | "query_reconcile" | "disabled";
  generation: number;
  roles: number;
  files: number;
  totalHashedFiles: number;
  lastReconcile?: {
    reason: string;
    hashedFiles: number;
    reusedFiles: number;
    completedAt: string;
  };
  error?: string;
};

export type PersonaSyncManifestIndexOptions = {
  readOnly?: boolean;
  watch?: boolean;
  reconcileOnQueryFallback?: boolean;
  onEvent?: (event: PersonaSyncManifestIndexEvent) => void;
};

type PendingPath = { roleId?: string; relativePath?: string };

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function fileId(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

function sameSignature(left: CachedPersonaSyncFile, stat: fs.Stats): boolean {
  return left.size === stat.size
    && left.mtimeMs === stat.mtimeMs
    && left.ctimeMs === stat.ctimeMs
    && left.fileId === fileId(stat);
}

function sameEntry(left: CachedPersonaSyncFile | undefined, right: CachedPersonaSyncFile | undefined): boolean {
  if (!left || !right) return left === right;
  return left.roleId === right.roleId
    && left.path === right.path
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.sha256 === right.sha256
    && left.mergeStrategy === right.mergeStrategy
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.fileId === right.fileId;
}

function sameIndex(
  previousRoles: Set<string>,
  nextRoles: Set<string>,
  previousFiles: Map<string, CachedPersonaSyncFile>,
  nextFiles: Map<string, CachedPersonaSyncFile>
): boolean {
  if (previousRoles.size !== nextRoles.size || previousFiles.size !== nextFiles.size) return false;
  for (const roleId of previousRoles) if (!nextRoles.has(roleId)) return false;
  for (const [key, file] of previousFiles) if (!sameEntry(file, nextFiles.get(key))) return false;
  return true;
}

function cacheKey(roleId: string, relativePath: string): string {
  return `${roleId}/${relativePath}`;
}

function normalizedRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function validRelativePath(value: string): boolean {
  const normalized = normalizedRelativePath(value);
  return Boolean(normalized)
    && normalized.length <= 1_000
    && normalized.split("/").every(segment => Boolean(segment) && segment !== "." && segment !== "..");
}

export function personaSyncFileEligible(relativePath: string, size: number): boolean {
  const normalized = normalizedRelativePath(relativePath).toLowerCase();
  if (size > MAX_SYNC_FILE_BYTES) return false;
  if (normalized.includes("/.") || normalized.startsWith(".")) return false;
  if (/\.(?:tmp|lock|part)$/i.test(normalized)) return false;
  if (normalized.includes("voice/cache/tts-audio/")) return false;
  return true;
}

function personaSyncDirectoryEligible(relativePath: string): boolean {
  const normalized = normalizedRelativePath(relativePath).toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("/.") || normalized.startsWith(".")) return false;
  if (normalized === "voice/cache/tts-audio" || normalized.startsWith("voice/cache/tts-audio/")) return false;
  return true;
}

function mergeStrategy(relativePath: string): PersonaSyncFile["mergeStrategy"] {
  return relativePath.toLowerCase().endsWith(".jsonl") ? "jsonl-union" : "three-way-file";
}

async function readStableEntry(
  roleId: string,
  relativePath: string,
  filePath: string,
  cached?: CachedPersonaSyncFile
): Promise<{ entry?: CachedPersonaSyncFile; hashed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: fs.Stats;
    try {
      before = await fs.promises.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hashed: false };
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || !personaSyncFileEligible(relativePath, before.size)) {
      return { hashed: false };
    }
    if (cached && sameSignature(cached, before)) return { entry: cached, hashed: false };
    let hash: string;
    try {
      hash = await sha256File(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hashed: false };
      throw error;
    }
    let after: fs.Stats;
    try {
      after = await fs.promises.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hashed: true };
      throw error;
    }
    if (after.isSymbolicLink() || !after.isFile() || !personaSyncFileEligible(relativePath, after.size)) {
      return { hashed: true };
    }
    if (before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || fileId(before) !== fileId(after)) {
      continue;
    }
    return {
      hashed: true,
      entry: {
        roleId,
        path: relativePath,
        size: after.size,
        modifiedAt: after.mtime.toISOString(),
        sha256: hash,
        mergeStrategy: mergeStrategy(relativePath),
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        fileId: fileId(after)
      }
    };
  }
  throw new Error(`Persona sync file kept changing while it was indexed: ${roleId}/${relativePath}`);
}

export class PersonaSyncManifestIndex {
  private readonly indexPath: string;
  private readonly options: Required<Pick<PersonaSyncManifestIndexOptions, "readOnly" | "watch" | "reconcileOnQueryFallback">>
    & Pick<PersonaSyncManifestIndexOptions, "onEvent">;
  private readonly rolesCache = new Set<string>();
  private readonly filesCache = new Map<string, CachedPersonaSyncFile>();
  private readonly pendingPaths = new Map<string, PendingPath>();
  private watcher: fs.FSWatcher | null = null;
  private readyPromise: Promise<void> | null = null;
  private reconcileFlight: Promise<void> | null = null;
  private pendingFlush: Promise<void> | null = null;
  private eventTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private fallbackRequired = false;
  private stopped = false;
  private generation = 0;
  private totalHashedFiles = 0;
  private state: PersonaSyncManifestIndexStatus["state"] = "idle";
  private lastReconcile: PersonaSyncManifestIndexStatus["lastReconcile"];
  private lastError = "";

  constructor(
    readonly rolesRoot: () => string,
    readonly stateRoot: string,
    options: PersonaSyncManifestIndexOptions = {}
  ) {
    this.indexPath = path.join(stateRoot, "manifest-index.json");
    this.options = {
      readOnly: options.readOnly === true,
      watch: options.watch !== false,
      reconcileOnQueryFallback: options.reconcileOnQueryFallback !== false,
      onEvent: options.onEvent
    };
    this.loadPersistedIndex();
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stopped = false;
    this.state = "initializing";
    this.readyPromise = this.initialize().catch(error => {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    return this.readyPromise;
  }

  async manifest(roleId?: string): Promise<PersonaSyncManifest> {
    const requested = roleId ? sanitizeRoleId(roleId) : "";
    if (roleId && !requested) throw new Error("Invalid persona id.");
    await this.start();
    if (this.watcher && !this.fallbackRequired) {
      // fs.watch delivery is asynchronous. A one-shot barrier lets an edit that
      // completed immediately before this explicit query enter the pending
      // event queue; it performs no business-state read and never rearms itself.
      await new Promise<void>(resolve => setTimeout(resolve, FILE_EVENT_BARRIER_MS));
    }
    await this.flushPendingEvents();
    if (this.fallbackRequired && this.options.reconcileOnQueryFallback) {
      await this.reconcileAll("query_fallback");
    }
    const roleIds = requested ? [requested] : [...this.rolesCache].sort((left, right) => left.localeCompare(right));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      roles: roleIds.flatMap(id => {
        if (!this.rolesCache.has(id)) return [];
        const files = [...this.filesCache.values()]
          .filter(file => file.roleId === id)
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(file => ({
            roleId: file.roleId,
            path: file.path,
            size: file.size,
            modifiedAt: file.modifiedAt,
            sha256: file.sha256,
            mergeStrategy: file.mergeStrategy
          }));
        return [{ roleId: id, files }];
      })
    };
  }

  notePathChanged(roleId: string, relativePath: string): void {
    const safeRoleId = sanitizeRoleId(roleId);
    const safePath = normalizedRelativePath(relativePath);
    if (!safeRoleId || !validRelativePath(safePath) || this.stopped) return;
    this.pendingPaths.set(cacheKey(safeRoleId, safePath), { roleId: safeRoleId, relativePath: safePath });
    this.armEventTimer();
  }

  status(): PersonaSyncManifestIndexStatus {
    return {
      state: this.state,
      watchMode: this.options.watch
        ? this.fallbackRequired ? "query_reconcile" : "recursive"
        : "disabled",
      generation: this.generation,
      roles: this.rolesCache.size,
      files: this.filesCache.size,
      totalHashedFiles: this.totalHashedFiles,
      lastReconcile: this.lastReconcile,
      error: this.lastError || undefined
    };
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    if (this.eventTimer) clearTimeout(this.eventTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.eventTimer = null;
    this.persistTimer = null;
    this.watcher?.close();
    this.watcher = null;
    if (!this.options.readOnly) this.persistNow();
  }

  private async initialize(): Promise<void> {
    await this.reconcileAll("startup");
    if (this.options.watch) {
      this.startWatcher();
      if (!this.fallbackRequired) await this.reconcileAll("post_watch");
    } else if (this.options.reconcileOnQueryFallback) {
      this.fallbackRequired = true;
    }
    this.state = this.fallbackRequired ? "fallback" : "ready";
    this.emit({ kind: "ready", generation: this.generation });
  }

  private startWatcher(): void {
    const root = path.resolve(this.rolesRoot());
    if (!fs.existsSync(root)) {
      this.enableFallback("Persona roles root is unavailable for file events.");
      return;
    }
    try {
      this.watcher = fs.watch(root, { recursive: true, encoding: "utf8" }, (_eventType, filename) => {
        if (this.stopped) return;
        if (!filename) {
          this.pendingPaths.set("*", {});
          this.armEventTimer();
          return;
        }
        const relative = normalizedRelativePath(String(filename));
        if (!validRelativePath(relative)) return;
        const segments = relative.split("/");
        const roleId = sanitizeRoleId(segments.shift());
        if (!roleId) return;
        const relativePath = segments.join("/");
        this.pendingPaths.set(relativePath ? cacheKey(roleId, relativePath) : `${roleId}/`, {
          roleId,
          relativePath: relativePath || undefined
        });
        this.armEventTimer();
      });
      this.watcher.unref();
      this.watcher.once("error", error => this.enableFallback(error instanceof Error ? error.message : String(error)));
    } catch (error) {
      this.enableFallback(error instanceof Error ? error.message : String(error));
    }
  }

  private enableFallback(message: string): void {
    this.watcher?.close();
    this.watcher = null;
    this.fallbackRequired = true;
    this.state = "fallback";
    this.lastError = message;
    this.emit({ kind: "watch_unavailable", generation: this.generation });
  }

  private armEventTimer(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.flushPendingEvents().catch(error => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.enableFallback(this.lastError);
      });
    }, FILE_EVENT_SETTLE_MS);
    this.eventTimer.unref();
  }

  private flushPendingEvents(): Promise<void> {
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.pendingFlush) return this.pendingFlush;
    if (!this.pendingPaths.size) return Promise.resolve();
    const pending = [...this.pendingPaths.values()];
    this.pendingPaths.clear();
    this.pendingFlush = this.applyPendingEvents(pending).finally(() => {
      this.pendingFlush = null;
      if (this.pendingPaths.size) this.armEventTimer();
    });
    return this.pendingFlush;
  }

  private async applyPendingEvents(pending: PendingPath[]): Promise<void> {
    if (pending.some(item => !item.roleId)) {
      await this.reconcileAll("ambiguous_file_event");
      return;
    }
    const fullRoles = new Set(pending.filter(item => !item.relativePath).map(item => item.roleId as string));
    for (const roleId of fullRoles) await this.reconcileRole(roleId, "role_directory_event");
    for (const item of pending) {
      if (!item.roleId || !item.relativePath || fullRoles.has(item.roleId)) continue;
      await this.refreshPath(item.roleId, item.relativePath);
    }
  }

  private async refreshPath(roleId: string, relativePath: string): Promise<void> {
    const root = path.join(this.rolesRoot(), roleId);
    const target = path.join(root, relativePath);
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      await this.reconcileRole(roleId, "directory_event");
      return;
    }
    const key = cacheKey(roleId, relativePath);
    const previous = this.filesCache.get(key);
    const result = stat && stat.isFile() && !stat.isSymbolicLink()
      // A concrete owner event is stronger evidence than cached metadata. Rehash
      // this one file even when a tool preserved its size or timestamps.
      ? await readStableEntry(roleId, relativePath, target)
      : { entry: undefined, hashed: false };
    if (result.hashed) this.totalHashedFiles += 1;
    if (result.entry) {
      this.rolesCache.add(roleId);
      if (!sameEntry(previous, result.entry)) {
        this.filesCache.set(key, result.entry);
        this.changed(previous ? "updated" : "created", roleId, relativePath);
      }
      return;
    }
    const prefix = `${key}/`;
    const removed = [...this.filesCache.keys()].filter(item => item === key || item.startsWith(prefix));
    if (removed.length) {
      for (const item of removed) this.filesCache.delete(item);
      this.changed("deleted", roleId, relativePath);
    }
    try {
      const roleStat = await fs.promises.lstat(root);
      if (!roleStat.isDirectory() || roleStat.isSymbolicLink()) this.rolesCache.delete(roleId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.rolesCache.delete(roleId);
      else throw error;
    }
  }

  private async reconcileRole(roleId: string, reason: string): Promise<void> {
    const root = path.join(this.rolesRoot(), roleId);
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      const prefix = `${roleId}/`;
      let changed = this.rolesCache.delete(roleId);
      for (const key of [...this.filesCache.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.filesCache.delete(key);
        changed = true;
      }
      if (changed) this.changed("deleted", roleId);
      return;
    }
    const previous = new Map([...this.filesCache].filter(([, file]) => file.roleId === roleId));
    const { files, hashedFiles, reusedFiles } = await this.scanRole(roleId, previous);
    let changed = false;
    for (const key of previous.keys()) {
      if (!files.has(key)) {
        this.filesCache.delete(key);
        changed = true;
      }
    }
    for (const [key, file] of files) {
      if (!sameEntry(this.filesCache.get(key), file)) changed = true;
      this.filesCache.set(key, file);
    }
    if (!this.rolesCache.has(roleId)) changed = true;
    this.rolesCache.add(roleId);
    this.totalHashedFiles += hashedFiles;
    this.lastReconcile = { reason, hashedFiles, reusedFiles, completedAt: new Date().toISOString() };
    if (changed) this.changed("reconciled", roleId);
  }

  private reconcileAll(reason: string): Promise<void> {
    if (this.reconcileFlight) return this.reconcileFlight;
    this.reconcileFlight = this.performReconcileAll(reason).finally(() => {
      this.reconcileFlight = null;
    });
    return this.reconcileFlight;
  }

  private async performReconcileAll(reason: string): Promise<void> {
    const previousRoles = new Set(this.rolesCache);
    const previousFiles = new Map(this.filesCache);
    const nextRoles = new Set<string>();
    const nextFiles = new Map<string, CachedPersonaSyncFile>();
    let roleEntries: fs.Dirent[] = [];
    try {
      roleEntries = await fs.promises.readdir(this.rolesRoot(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let hashedFiles = 0;
    let reusedFiles = 0;
    for (const roleEntry of roleEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!roleEntry.isDirectory() || roleEntry.isSymbolicLink()) continue;
      const roleId = sanitizeRoleId(roleEntry.name);
      if (!roleId) continue;
      nextRoles.add(roleId);
      const previous = new Map([...previousFiles].filter(([, file]) => file.roleId === roleId));
      const scanned = await this.scanRole(roleId, previous);
      hashedFiles += scanned.hashedFiles;
      reusedFiles += scanned.reusedFiles;
      for (const [key, file] of scanned.files) nextFiles.set(key, file);
    }
    const changed = !sameIndex(previousRoles, nextRoles, previousFiles, nextFiles);
    this.rolesCache.clear();
    this.filesCache.clear();
    for (const roleId of nextRoles) this.rolesCache.add(roleId);
    for (const [key, file] of nextFiles) this.filesCache.set(key, file);
    this.totalHashedFiles += hashedFiles;
    this.lastReconcile = { reason, hashedFiles, reusedFiles, completedAt: new Date().toISOString() };
    if (changed) this.changed("reconciled");
    else if (!this.options.readOnly && reason === "startup") this.schedulePersist();
  }

  private async scanRole(
    roleId: string,
    previous: Map<string, CachedPersonaSyncFile>
  ): Promise<{ files: Map<string, CachedPersonaSyncFile>; hashedFiles: number; reusedFiles: number }> {
    const root = path.join(this.rolesRoot(), roleId);
    const candidates: Array<{ relativePath: string; filePath: string }> = [];
    const visit = async (directory: string, current: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = normalizedRelativePath(current ? `${current}/${entry.name}` : entry.name);
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (personaSyncDirectoryEligible(relativePath)) await visit(target, relativePath);
          continue;
        }
        if (entry.isFile()) candidates.push({ relativePath, filePath: target });
      }
    };
    await visit(root, "");
    const files = new Map<string, CachedPersonaSyncFile>();
    let hashedFiles = 0;
    let reusedFiles = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, Math.max(1, candidates.length)) }, async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        const key = cacheKey(roleId, candidate.relativePath);
        const result = await readStableEntry(roleId, candidate.relativePath, candidate.filePath, previous.get(key));
        if (result.hashed) hashedFiles += 1;
        else if (result.entry) reusedFiles += 1;
        if (result.entry) files.set(key, result.entry);
      }
    });
    await Promise.all(workers);
    return { files, hashedFiles, reusedFiles };
  }

  private changed(kind: PersonaSyncManifestIndexEvent["kind"], roleId?: string, relativePath?: string): void {
    this.generation += 1;
    this.schedulePersist();
    this.emit({ kind, roleId, path: relativePath, generation: this.generation });
  }

  private emit(event: PersonaSyncManifestIndexEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Index correctness does not depend on observers.
    }
  }

  private schedulePersist(): void {
    if (this.options.readOnly || this.stopped) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, INDEX_PERSIST_SETTLE_MS);
    this.persistTimer.unref();
  }

  private persistNow(): void {
    if (this.options.readOnly) return;
    const payload: PersistedManifestIndex = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      roles: [...this.rolesCache].sort((left, right) => left.localeCompare(right)),
      files: [...this.filesCache.values()].sort((left, right) =>
        left.roleId.localeCompare(right.roleId) || left.path.localeCompare(right.path)
      )
    };
    atomicWriteFileSync(this.indexPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private loadPersistedIndex(): void {
    let parsed: Partial<PersistedManifestIndex>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as Partial<PersistedManifestIndex>;
    } catch {
      return;
    }
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(parsed.roles) || !Array.isArray(parsed.files)) return;
    for (const role of parsed.roles) {
      const roleId = sanitizeRoleId(role);
      if (roleId) this.rolesCache.add(roleId);
    }
    for (const raw of parsed.files) {
      const roleId = sanitizeRoleId(raw?.roleId);
      const relativePath = normalizedRelativePath(String(raw?.path || ""));
      if (!roleId || !validRelativePath(relativePath)) continue;
      const size = Number(raw?.size);
      const mtimeMs = Number(raw?.mtimeMs);
      const ctimeMs = Number(raw?.ctimeMs);
      const hash = String(raw?.sha256 || "");
      const id = String(raw?.fileId || "");
      if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)
        || !/^[a-f0-9]{64}$/i.test(hash) || !id || !personaSyncFileEligible(relativePath, size)) continue;
      this.rolesCache.add(roleId);
      this.filesCache.set(cacheKey(roleId, relativePath), {
        roleId,
        path: relativePath,
        size,
        modifiedAt: new Date(mtimeMs).toISOString(),
        sha256: hash.toLowerCase(),
        mergeStrategy: mergeStrategy(relativePath),
        mtimeMs,
        ctimeMs,
        fileId: id
      });
    }
  }
}
