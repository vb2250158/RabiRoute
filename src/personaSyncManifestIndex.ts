import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PersonaSyncFile, PersonaSyncManifest } from "./personaSync.js";
import {
  inspectPlanStorageConflict,
  validateCanonicalActivePlanDirectory,
  validateCanonicalArchivedPlanDirectory
} from "./planStoragePolicy.js";
import {
  canonicalPlanIdForStorageIdentity,
  personaPlanStoragePath
} from "./personaPlanStorage.js";
import { canonicalPlanStorageCollisionIdentity } from "./planStorageLayout.js";
import { withPlanStorageLease as withPlanStorageLock } from "./planStorageRepository.js";
import { archivedPlanPackageInventory } from "./personaSyncPlanPackage.js";
import { runPersonaSyncManifestWorker } from "./personaSyncManifestWorkerClient.js";
import type {
  PersonaSyncManifestCacheFile,
  PersonaSyncManifestCachePayload,
  PersonaSyncManifestRefreshResult
} from "./personaSyncManifestWorkerProtocol.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { requiresWorkerFilesystemAccess } from "./shared/pathPolicy.js";
import { sanitizeRoleId } from "./shared/routeIdentity.js";

const INDEX_SCHEMA_VERSION = 1;
const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024;
const FILE_EVENT_SETTLE_MS = 80;
const FILE_EVENT_BARRIER_MS = 50;
const INDEX_PERSIST_SETTLE_MS = 120;
const HASH_CONCURRENCY = 4;

type CachedPersonaSyncFile = PersonaSyncManifestCacheFile;

type PhysicalPlanScope = {
  storageId: string;
  bucket: "active" | "archive";
  directory: string;
};

function physicalPlanScopes(roleDir: string): Map<string, PhysicalPlanScope> {
  const scopes = new Map<string, PhysicalPlanScope>();
  for (const bucket of ["active", "archive"] as const) {
    const bucketDirectory = path.join(roleDir, "plans", bucket);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(bucketDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Persona sync rejected non-canonical plan storage entry: ${bucket}/${entry.name}`);
      }
      const parsed = personaPlanStoragePath(`plans/${bucket}/${entry.name}/plan.json`);
      if (!parsed || parsed.bucket !== bucket) {
        throw new Error(`Persona sync rejected non-canonical plan storage path: ${bucket}/${entry.name}`);
      }
      const key = canonicalPlanStorageCollisionIdentity(parsed.storageId);
      if (scopes.has(key)) {
        throw new Error(`Persona sync rejected duplicate active/archive plan storage: ${entry.name}`);
      }
      scopes.set(key, {
        storageId: parsed.storageId,
        bucket,
        directory: path.join(bucketDirectory, entry.name)
      });
    }
  }
  return scopes;
}

type PersistedManifestIndex = PersonaSyncManifestCachePayload;

export type PersonaSyncManifestIndexEvent = {
  kind: "ready" | "created" | "updated" | "deleted" | "reconciled" | "watch_unavailable" | "persistence_failed";
  roleId?: string;
  path?: string;
  generation: number;
};

export type PersonaSyncManifestIndexPersistenceStatus = {
  consecutiveFailures: number;
  totalFailures: number;
  lastPersistedAt?: string;
  lastFailureAt?: string;
  nextRetryAt?: string;
  lastError?: string;
};

export type PersonaSyncManifestIndexStatus = {
  state: "idle" | "initializing" | "ready" | "fallback" | "failed" | "stopped";
  watchMode: "recursive" | "query_reconcile" | "worker_poll" | "disabled";
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
  persistence: PersonaSyncManifestIndexPersistenceStatus;
  publication: {
    executionMode: "inline" | "child_process";
    available: boolean;
    revision: number;
    state: "empty" | "refreshing" | "ready" | "degraded";
    stale: boolean;
    refreshedAt?: string;
    refreshStartedAt?: string;
    workerPid?: number;
    deadlineMs: number;
    error?: string;
  };
  error?: string;
};

export type PersonaSyncManifestPublishedSnapshot = {
  manifest?: PersonaSyncManifest;
  publication: PersonaSyncManifestIndexStatus["publication"];
};

export type PersonaSyncManifestIndexOptions = {
  readOnly?: boolean;
  watch?: boolean;
  reconcileOnQueryFallback?: boolean;
  scanExecutionMode?: "inline" | "child_process";
  autoStart?: boolean;
  refreshTimeoutMs?: number;
  remoteRefreshIntervalMs?: number;
  runManifestWorker?: typeof runPersonaSyncManifestWorker;
  onEvent?: (event: PersonaSyncManifestIndexEvent) => void;
  persistSettleMs?: number;
  persistRetryBaseMs?: number;
  persistRetryMaxMs?: number;
  writePersistedIndex?: (filePath: string, content: string | Buffer) => void;
  watchFactory?: (
    root: string,
    listener: (eventType: fs.WatchEventType, filename: string | Buffer | null) => void
  ) => fs.FSWatcher;
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

function immutableManifest(manifest: PersonaSyncManifest): PersonaSyncManifest {
  const roles = manifest.roles.map(role => Object.freeze({
    roleId: role.roleId,
    files: Object.freeze(role.files.map(file => Object.freeze({ ...file })))
  }));
  return Object.freeze({
    schemaVersion: 1 as const,
    generatedAt: manifest.generatedAt,
    roles: Object.freeze(roles)
  }) as unknown as PersonaSyncManifest;
}

const EXCLUDED_RUNTIME_DIRECTORIES = new Set([
  "state/work-cycle-history",
  "state/work-cycle-history-locks",
  "state/work-cycle-inputs",
  "state/work-cycle-plan-locks",
  "state/work-cycle-receipt-locks",
  "conversation/situations",
  "plans/items",
  "plans/history",
  "plans/feedback",
  "plans/attachments",
  "plans/quarantine",
  "plans/.staging",
  "voice/cache/tts-audio"
]);

export function personaSyncPathEligible(relativePath: string): boolean {
  const normalized = normalizedRelativePath(relativePath).toLowerCase();
  if (!normalized) return true;
  const segments = normalized.split("/");
  if (segments.some(segment => !segment || segment.startsWith(".") || segment === "tmp" || segment === "temp")) {
    return false;
  }
  if (/\.(?:tmp|lock|part)$/i.test(normalized)) return false;
  if (/^plans\/archive\/[^/]+\.json$/i.test(normalized)) return false;
  return ![...EXCLUDED_RUNTIME_DIRECTORIES]
    .some(directory => normalized === directory || normalized.startsWith(`${directory}/`));
}

export function personaSyncFileEligible(relativePath: string, size: number): boolean {
  if (size > MAX_SYNC_FILE_BYTES) return false;
  return personaSyncPathEligible(relativePath);
}

function personaSyncDirectoryEligible(relativePath: string): boolean {
  return personaSyncPathEligible(relativePath);
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
  private readonly options: {
    readOnly: boolean;
    watch: boolean;
    reconcileOnQueryFallback: boolean;
    scanExecutionMode: "inline" | "child_process";
    autoStart: boolean;
    refreshTimeoutMs: number;
    remoteRefreshIntervalMs: number;
    runManifestWorker: typeof runPersonaSyncManifestWorker;
    onEvent?: (event: PersonaSyncManifestIndexEvent) => void;
    persistSettleMs: number;
    persistRetryBaseMs: number;
    persistRetryMaxMs: number;
    writePersistedIndex: (filePath: string, content: string | Buffer) => void;
    watchFactory: (
      root: string,
      listener: (eventType: fs.WatchEventType, filename: string | Buffer | null) => void
    ) => fs.FSWatcher;
  };
  private readonly rolesCache = new Set<string>();
  private readonly filesCache = new Map<string, CachedPersonaSyncFile>();
  private readonly pendingPaths = new Map<string, PendingPath>();
  private watcher: fs.FSWatcher | null = null;
  private readyPromise: Promise<void> | null = null;
  private scanMutationTail: Promise<void> = Promise.resolve();
  private workerRefreshFlight: Promise<void> | null = null;
  private workerRefreshQueuedReason: string | null = null;
  private workerRefreshAbort: AbortController | null = null;
  private pendingFlush: Promise<void> | null = null;
  private eventTimer: NodeJS.Timeout | null = null;
  private remoteRefreshTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private fallbackRequired = false;
  private remoteWorkerPollRequired = false;
  private stopped = false;
  private generation = 0;
  private totalHashedFiles = 0;
  private state: PersonaSyncManifestIndexStatus["state"] = "idle";
  private lastReconcile: PersonaSyncManifestIndexStatus["lastReconcile"];
  private lastError = "";
  private persistConsecutiveFailures = 0;
  private persistTotalFailures = 0;
  private lastPersistedAt = "";
  private lastPersistFailureAt = "";
  private nextPersistRetryAt = "";
  private lastPersistError = "";
  private publishedManifest = immutableManifest({
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    roles: []
  });
  private publishedAvailable = false;
  private publicationRevision = 0;
  private publicationState: PersonaSyncManifestIndexStatus["publication"]["state"] = "empty";
  private publicationStale = true;
  private publicationRefreshedAt = "";
  private publicationRefreshStartedAt = "";
  private publicationError = "";
  private publicationWorkerPid: number | undefined;

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
      scanExecutionMode: options.scanExecutionMode ?? "inline",
      autoStart: options.autoStart === true,
      refreshTimeoutMs: Math.max(100, Math.floor(options.refreshTimeoutMs ?? 5_000)),
      remoteRefreshIntervalMs: Math.max(250, Math.floor(options.remoteRefreshIntervalMs ?? 5_000)),
      runManifestWorker: options.runManifestWorker ?? runPersonaSyncManifestWorker,
      onEvent: options.onEvent,
      persistSettleMs: Math.max(0, Math.floor(options.persistSettleMs ?? INDEX_PERSIST_SETTLE_MS)),
      persistRetryBaseMs: Math.max(1, Math.floor(options.persistRetryBaseMs ?? 250)),
      persistRetryMaxMs: Math.max(1, Math.floor(options.persistRetryMaxMs ?? 30_000)),
      writePersistedIndex: options.writePersistedIndex ?? atomicWriteFileSync,
      watchFactory: options.watchFactory ?? ((watchRoot, listener) => fs.watch(
        watchRoot,
        { recursive: true, encoding: "utf8" },
        listener
      ))
    };
    this.options.persistRetryMaxMs = Math.max(this.options.persistRetryBaseMs, this.options.persistRetryMaxMs);
    this.loadPersistedIndex();
    this.publishedManifest = immutableManifest(this.snapshotFromCache());
    if (this.options.readOnly) {
      this.publishedAvailable = true;
      this.publicationRevision = 1;
      this.publicationState = "ready";
      this.publicationStale = false;
      this.publicationRefreshedAt = this.publishedManifest.generatedAt;
    }
    if (this.options.scanExecutionMode === "child_process" && this.options.autoStart) {
      setImmediate(() => {
        void this.start().catch(error => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
      });
    }
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
    const requested = this.requestedRoleId(roleId);
    await this.start();
    if (this.options.scanExecutionMode === "child_process") {
      const published = this.publishedSnapshot(requested || undefined);
      if (!published.manifest) throw new Error(published.publication.error || "Persona manifest snapshot is not ready.");
      return published.manifest;
    }
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
    const planRoleIds = requested ? [requested] : [...this.rolesCache];
    for (const planRoleId of planRoleIds) {
      const rolePlansRoot = path.join(this.rolesRoot(), planRoleId, "plans");
      const cachedPlanExists = [...this.filesCache.values()].some(file =>
        file.roleId === planRoleId && Boolean(personaPlanStoragePath(file.path))
      );
      if (cachedPlanExists || fs.existsSync(rolePlansRoot)) {
        await this.reconcileDirectory(planRoleId, "plans", "authoritative_plan_manifest_query");
      }
    }
    const manifest = this.snapshotFromCache(requested || undefined, true);
    this.publishManifest(manifest, false);
    return this.snapshot(requested || undefined);
  }

  snapshot(roleId?: string): PersonaSyncManifest {
    const published = this.publishedSnapshot(roleId);
    return published.manifest ?? immutableManifest({
      schemaVersion: 1,
      generatedAt: this.publishedManifest.generatedAt,
      roles: []
    });
  }

  publishedSnapshot(roleId?: string): PersonaSyncManifestPublishedSnapshot {
    const requested = this.requestedRoleId(roleId);
    const publication = this.publicationStatus();
    if (!this.publishedAvailable) return { publication };
    if (!requested) return { manifest: this.publishedManifest, publication };
    return {
      manifest: immutableManifest({
        schemaVersion: 1,
        generatedAt: this.publishedManifest.generatedAt,
        roles: this.publishedManifest.roles.filter(role => role.roleId === requested)
      }),
      publication
    };
  }

  cacheSnapshot(): PersonaSyncManifestCachePayload {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      roles: [...this.rolesCache].sort((left, right) => left.localeCompare(right)),
      files: [...this.filesCache.values()]
        .sort((left, right) => left.roleId.localeCompare(right.roleId) || left.path.localeCompare(right.path))
        .map(file => ({ ...file }))
    };
  }

  private snapshotFromCache(roleId?: string, validatePlanStorage = false): PersonaSyncManifest {
    const requested = this.requestedRoleId(roleId);
    const roleIds = requested ? [requested] : [...this.rolesCache].sort((left, right) => left.localeCompare(right));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      roles: roleIds.flatMap(id => {
        if (!this.rolesCache.has(id)) return [];
        const cachedFiles = [...this.filesCache.values()]
          .filter(file => file.roleId === id)
          .sort((left, right) => left.path.localeCompare(right.path));
        if (!validatePlanStorage) {
          return [{
            roleId: id,
            files: cachedFiles.map(file => ({
              roleId: file.roleId,
              path: file.path,
              size: file.size,
              modifiedAt: file.modifiedAt,
              sha256: file.sha256,
              mergeStrategy: file.mergeStrategy
            }))
          }];
        }
        const roleDir = path.join(this.rolesRoot(), id);
        const cachedPlanScopes = new Map<string, CachedPersonaSyncFile[]>();
        for (const file of cachedFiles) {
          const planPath = personaPlanStoragePath(file.path);
          if (!planPath) continue;
          const key = canonicalPlanStorageCollisionIdentity(planPath.storageId);
          const scope = cachedPlanScopes.get(key) ?? [];
          scope.push(file);
          cachedPlanScopes.set(key, scope);
        }
        const diskPlanScopes = physicalPlanScopes(roleDir);
        const staleCachedScopes = [...cachedPlanScopes.keys()].filter(key => !diskPlanScopes.has(key));
        if (staleCachedScopes.length > 0) {
          throw new Error(`Persona sync rejected stale plan manifest scopes: ${id}/${staleCachedScopes.join(",")}`);
        }
        for (const [storageIdentity, diskScope] of diskPlanScopes) {
          const scopeFiles = cachedPlanScopes.get(storageIdentity) ?? [];
          const parsed = scopeFiles.map(file => ({ file, planPath: personaPlanStoragePath(file.path)! }));
          const buckets = new Set(parsed.map(item => item.planPath.bucket));
          const identities = parsed.filter(item => item.file.path.replace(/\\/g, "/").toLowerCase().endsWith("/plan.json"));
          if (buckets.size !== 1 || !buckets.has(diskScope.bucket) || identities.length !== 1) {
            throw new Error(`Persona sync rejected incomplete or ambiguous plan package ${id}/${storageIdentity}`);
          }
          withPlanStorageLock(roleDir, diskScope.storageId, () => {
            const planId = canonicalPlanIdForStorageIdentity(roleDir, diskScope.storageId);
            if (!planId) throw new Error(`Persona sync plan package identity disappeared: ${id}/${storageIdentity}`);
            const inspection = inspectPlanStorageConflict(roleDir, planId);
            if (inspection.status !== "single") {
              throw new Error(`Persona sync rejected unresolved plan lifecycle ${id}/${planId}: ${inspection.reason}`);
            }
            if (diskScope.bucket === "archive") validateCanonicalArchivedPlanDirectory(diskScope.directory, planId);
            else validateCanonicalActivePlanDirectory(diskScope.directory, planId);
            const inventory = archivedPlanPackageInventory(diskScope.directory);
            const prefix = `plans/${diskScope.bucket}/${diskScope.storageId}/`;
            const cachedByPath = new Map(scopeFiles.map(file => [file.path, file]));
            if (inventory.files.length !== scopeFiles.length || inventory.files.some(entry => {
              const cached = cachedByPath.get(`${prefix}${entry.path}`);
              return !cached || cached.size !== entry.size || cached.sha256 !== entry.sha256;
            })) {
              throw new Error(`Persona sync rejected a stale or partial plan manifest cache: ${id}/${planId}`);
            }
          });
        }
        const files = cachedFiles.map(file => ({
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

  private requestedRoleId(roleId?: string): string {
    const requested = roleId ? sanitizeRoleId(roleId) : "";
    if (roleId && !requested) throw new Error("Invalid persona id.");
    return requested;
  }

  notePathChanged(roleId: string, relativePath: string): void {
    const safeRoleId = sanitizeRoleId(roleId);
    const safePath = normalizedRelativePath(relativePath);
    if (!safeRoleId || !validRelativePath(safePath) || !personaSyncPathEligible(safePath) || this.stopped) return;
    this.pendingPaths.set(cacheKey(safeRoleId, safePath), { roleId: safeRoleId, relativePath: safePath });
    this.armEventTimer();
  }

  status(): PersonaSyncManifestIndexStatus {
    return {
      state: this.state,
      watchMode: this.options.watch
        ? this.remoteWorkerPollRequired
          ? "worker_poll"
          : this.fallbackRequired
            ? "query_reconcile"
          : "recursive"
        : "disabled",
      generation: this.generation,
      roles: this.rolesCache.size,
      files: this.filesCache.size,
      totalHashedFiles: this.totalHashedFiles,
      lastReconcile: this.lastReconcile,
      persistence: {
        consecutiveFailures: this.persistConsecutiveFailures,
        totalFailures: this.persistTotalFailures,
        lastPersistedAt: this.lastPersistedAt || undefined,
        lastFailureAt: this.lastPersistFailureAt || undefined,
        nextRetryAt: this.nextPersistRetryAt || undefined,
        lastError: this.lastPersistError || undefined
      },
      publication: this.publicationStatus(),
      error: this.lastError || undefined
    };
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    if (this.eventTimer) clearTimeout(this.eventTimer);
    if (this.remoteRefreshTimer) clearTimeout(this.remoteRefreshTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.eventTimer = null;
    this.remoteRefreshTimer = null;
    this.persistTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.workerRefreshAbort?.abort();
    this.workerRefreshAbort = null;
    if (!this.options.readOnly) this.persistNow();
  }

  private async initialize(): Promise<void> {
    if (this.options.readOnly && !this.options.watch && !this.options.reconcileOnQueryFallback) {
      // Read-only acceptance and diagnostics must never block the Manager on a
      // fresh NAS walk. They use the persisted, rebuildable index snapshot.
      this.state = "ready";
      this.emit({ kind: "ready", generation: this.generation });
      return;
    }
    if (this.options.scanExecutionMode === "child_process") {
      if (this.options.watch) this.startWatcher();
      await this.refreshManifestInWorker("startup");
      if (this.pendingPaths.size) await this.flushPendingEvents();
      this.state = this.fallbackRequired ? "fallback" : "ready";
      this.emit({ kind: "ready", generation: this.generation });
      return;
    }
    await this.reconcileAll("startup");
    if (this.options.watch) {
      this.startWatcher();
      if (!this.fallbackRequired) await this.reconcileAll("post_watch");
    } else if (this.options.reconcileOnQueryFallback) {
      this.fallbackRequired = true;
    }
    this.publishManifest(this.snapshotFromCache(undefined, true), false);
    this.state = this.fallbackRequired ? "fallback" : "ready";
    this.emit({ kind: "ready", generation: this.generation });
  }

  private startWatcher(): void {
    const configuredRoot = this.rolesRoot();
    if (requiresWorkerFilesystemAccess(configuredRoot)) {
      this.remoteWorkerPollRequired = true;
      this.scheduleWorkerRefreshPoll();
      return;
    }
    const root = path.resolve(configuredRoot);
    if (this.options.scanExecutionMode === "inline" && !fs.existsSync(root)) {
      this.enableFallback("Persona roles root is unavailable for file events.");
      return;
    }
    try {
      this.watcher = this.options.watchFactory(root, (_eventType, filename) => {
        if (this.stopped) return;
        if (!filename) {
          this.enableFallback("Persona file watching did not identify the changed path; explicit sync queries will reconcile the persisted index.");
          return;
        }
        const relative = normalizedRelativePath(String(filename));
        if (!validRelativePath(relative)) return;
        const segments = relative.split("/");
        const roleId = sanitizeRoleId(segments.shift());
        if (!roleId) return;
        const relativePath = segments.join("/");
        if (relativePath && !personaSyncPathEligible(relativePath)) return;
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
    this.scheduleWorkerRefreshPoll();
  }

  private scheduleWorkerRefreshPoll(): void {
    if (this.options.scanExecutionMode !== "child_process"
      || (!this.remoteWorkerPollRequired && !this.fallbackRequired)
      || this.stopped
      || this.remoteRefreshTimer) {
      return;
    }
    this.remoteRefreshTimer = setTimeout(() => {
      this.remoteRefreshTimer = null;
      void this.refreshManifestInWorker("bounded_remote_poll")
        .catch(() => undefined)
        .finally(() => this.scheduleWorkerRefreshPoll());
    }, this.options.remoteRefreshIntervalMs);
    this.remoteRefreshTimer.unref?.();
  }

  private armEventTimer(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.flushPendingEvents().catch(error => {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (this.options.scanExecutionMode === "inline") this.enableFallback(this.lastError);
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
    if (this.options.scanExecutionMode === "child_process") {
      await this.refreshManifestInWorker(pending.some(item => !item.roleId)
        ? "ambiguous_file_event"
        : "file_event");
      return;
    }
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

  private refreshPath(roleId: string, relativePath: string): Promise<void> {
    return this.enqueueScanMutation(() => this.performRefreshPath(roleId, relativePath));
  }

  private async performRefreshPath(roleId: string, relativePath: string): Promise<void> {
    const root = path.join(this.rolesRoot(), roleId);
    const target = path.join(root, relativePath);
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      await this.performReconcileDirectory(roleId, relativePath, "directory_event");
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

  private reconcileRole(roleId: string, reason: string): Promise<void> {
    return this.enqueueScanMutation(() => this.performReconcileRole(roleId, reason));
  }

  private async performReconcileRole(roleId: string, reason: string): Promise<void> {
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

  private reconcileDirectory(roleId: string, relativePath: string, reason: string): Promise<void> {
    return this.enqueueScanMutation(() => this.performReconcileDirectory(roleId, relativePath, reason));
  }

  private async performReconcileDirectory(roleId: string, relativePath: string, reason: string): Promise<void> {
    const normalized = normalizedRelativePath(relativePath);
    const keyPrefix = `${cacheKey(roleId, normalized)}/`;
    const previous = new Map([...this.filesCache].filter(([key]) => key.startsWith(keyPrefix)));
    const { files, hashedFiles, reusedFiles } = await this.scanDirectory(roleId, normalized, previous);
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
    this.rolesCache.add(roleId);
    this.totalHashedFiles += hashedFiles;
    this.lastReconcile = { reason, hashedFiles, reusedFiles, completedAt: new Date().toISOString() };
    if (changed) this.changed("reconciled", roleId, normalized);
  }

  private reconcileAll(reason: string): Promise<void> {
    return this.enqueueScanMutation(() => this.performReconcileAll(reason));
  }

  private enqueueScanMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.scanMutationTail.catch(() => undefined).then(operation);
    this.scanMutationTail = result.then(() => undefined, () => undefined);
    return result;
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
    return this.scanDirectory(roleId, "", previous);
  }

  private async scanDirectory(
    roleId: string,
    relativeRoot: string,
    previous: Map<string, CachedPersonaSyncFile>
  ): Promise<{ files: Map<string, CachedPersonaSyncFile>; hashedFiles: number; reusedFiles: number }> {
    const root = path.join(this.rolesRoot(), roleId, relativeRoot);
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
    await visit(root, relativeRoot);
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

  private publicationStatus(): PersonaSyncManifestIndexStatus["publication"] {
    return {
      executionMode: this.options.scanExecutionMode,
      available: this.publishedAvailable,
      revision: this.publicationRevision,
      state: this.publicationState,
      stale: this.publicationStale,
      refreshedAt: this.publicationRefreshedAt || undefined,
      refreshStartedAt: this.publicationRefreshStartedAt || undefined,
      workerPid: this.publicationWorkerPid,
      deadlineMs: this.options.refreshTimeoutMs,
      error: this.publicationError || undefined
    };
  }

  private publishManifest(manifest: PersonaSyncManifest, stale: boolean): void {
    this.publishedManifest = immutableManifest(manifest);
    this.publishedAvailable = true;
    this.publicationRevision += 1;
    this.publicationState = stale ? "degraded" : "ready";
    this.publicationStale = stale;
    this.publicationRefreshedAt = new Date().toISOString();
    this.publicationError = "";
  }

  private refreshManifestInWorker(reason: string): Promise<void> {
    if (this.workerRefreshFlight) {
      this.workerRefreshQueuedReason = reason;
      return this.workerRefreshFlight;
    }
    this.workerRefreshQueuedReason = null;
    this.workerRefreshFlight = this.runManifestWorkerRefreshes(reason).finally(() => {
      this.workerRefreshFlight = null;
      this.scheduleWorkerRefreshPoll();
    });
    return this.workerRefreshFlight;
  }

  private async runManifestWorkerRefreshes(initialReason: string): Promise<void> {
    let reason: string | null = initialReason;
    while (reason && !this.stopped) {
      await this.runManifestWorkerRefresh(reason);
      reason = this.workerRefreshQueuedReason;
      this.workerRefreshQueuedReason = null;
    }
  }

  private async runManifestWorkerRefresh(reason: string): Promise<void> {
    const controller = new AbortController();
    this.workerRefreshAbort = controller;
    this.publicationState = "refreshing";
    this.publicationStale = this.publishedAvailable;
    this.publicationRefreshStartedAt = new Date().toISOString();
    this.publicationError = "";
    try {
      const result = await this.options.runManifestWorker(
        this.rolesRoot(),
        this.stateRoot,
        {
          timeoutMs: this.options.refreshTimeoutMs,
          signal: controller.signal,
          onSpawn: pid => { this.publicationWorkerPid = pid; }
        }
      );
      if (this.stopped) return;
      this.publishWorkerResult(result, reason);
      this.state = this.fallbackRequired ? "fallback" : "ready";
      this.lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publicationState = "degraded";
      this.publicationStale = true;
      this.publicationError = message;
      this.lastError = message;
      throw error;
    } finally {
      this.publicationWorkerPid = undefined;
      if (this.workerRefreshAbort === controller) this.workerRefreshAbort = null;
    }
  }

  private publishWorkerResult(result: PersonaSyncManifestRefreshResult, reason: string): void {
    if (result.schemaVersion !== INDEX_SCHEMA_VERSION || result.cache.schemaVersion !== INDEX_SCHEMA_VERSION) {
      throw new Error("Persona manifest worker returned an unsupported cache schema.");
    }
    const nextRoles = new Set<string>();
    for (const rawRole of result.cache.roles) {
      const roleId = sanitizeRoleId(rawRole);
      if (!roleId || roleId !== rawRole) throw new Error("Persona manifest worker returned an invalid role id.");
      nextRoles.add(roleId);
    }
    const nextFiles = new Map<string, CachedPersonaSyncFile>();
    for (const raw of result.cache.files) {
      const roleId = sanitizeRoleId(raw?.roleId);
      const relativePath = normalizedRelativePath(String(raw?.path || ""));
      const size = Number(raw?.size);
      const mtimeMs = Number(raw?.mtimeMs);
      const ctimeMs = Number(raw?.ctimeMs);
      const hash = String(raw?.sha256 || "");
      const id = String(raw?.fileId || "");
      if (!roleId || roleId !== raw.roleId || !nextRoles.has(roleId) || !validRelativePath(relativePath)
        || !Number.isFinite(size) || !Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)
        || !/^[a-f0-9]{64}$/i.test(hash) || !id || !personaSyncFileEligible(relativePath, size)) {
        throw new Error("Persona manifest worker returned an invalid cache entry.");
      }
      const key = cacheKey(roleId, relativePath);
      if (nextFiles.has(key)) throw new Error(`Persona manifest worker returned duplicate file ${key}.`);
      nextFiles.set(key, {
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
    const changed = !sameIndex(this.rolesCache, nextRoles, this.filesCache, nextFiles);
    this.rolesCache.clear();
    this.filesCache.clear();
    for (const roleId of nextRoles) this.rolesCache.add(roleId);
    for (const [key, file] of nextFiles) this.filesCache.set(key, file);
    this.totalHashedFiles += Math.max(0, Math.floor(result.scan.hashedFiles));
    this.lastReconcile = {
      reason,
      hashedFiles: Math.max(0, Math.floor(result.scan.hashedFiles)),
      reusedFiles: Math.max(0, Math.floor(result.scan.reusedFiles)),
      completedAt: result.scan.completedAt
    };
    this.publishManifest(this.snapshotFromCache(), false);
    if (changed) {
      this.generation += 1;
      this.emit({ kind: "reconciled", generation: this.generation });
    }
    this.schedulePersist();
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

  private schedulePersist(delayMs = this.options.persistSettleMs): void {
    if (this.options.readOnly || this.stopped) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, Math.max(0, delayMs));
    this.persistTimer.unref();
  }

  private persistNow(): boolean {
    if (this.options.readOnly) return true;
    const payload: PersistedManifestIndex = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      roles: [...this.rolesCache].sort((left, right) => left.localeCompare(right)),
      files: [...this.filesCache.values()].sort((left, right) =>
        left.roleId.localeCompare(right.roleId) || left.path.localeCompare(right.path)
      )
    };
    try {
      this.options.writePersistedIndex(this.indexPath, `${JSON.stringify(payload, null, 2)}\n`);
      this.persistConsecutiveFailures = 0;
      this.lastPersistedAt = new Date().toISOString();
      this.nextPersistRetryAt = "";
      this.lastPersistError = "";
      return true;
    } catch (error) {
      this.persistConsecutiveFailures += 1;
      this.persistTotalFailures += 1;
      this.lastPersistFailureAt = new Date().toISOString();
      const code = String((error as NodeJS.ErrnoException).code || "").trim();
      const message = error instanceof Error ? error.message : String(error);
      this.lastPersistError = `${code ? `${code}: ` : ""}${message}`;
      const retryDelay = Math.min(
        this.options.persistRetryMaxMs,
        this.options.persistRetryBaseMs * (2 ** Math.min(16, this.persistConsecutiveFailures - 1))
      );
      this.nextPersistRetryAt = new Date(Date.now() + retryDelay).toISOString();
      console.error(
        `Persona sync manifest index persistence failed; the rebuildable cache remains in memory and will retry in ${retryDelay}ms: ${this.lastPersistError}`
      );
      this.emit({ kind: "persistence_failed", generation: this.generation });
      this.schedulePersist(retryDelay);
      return false;
    }
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
