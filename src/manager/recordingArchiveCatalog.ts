import { auditRecordingArchiveMutation } from "./recordingArchiveAudit.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { validateRecordingManifest, recordingManifestHash, validateArchiveReceipt, type RecordingManifest, type ArchiveReceipt } from "./recordingArchiveContract.js";
import type { RecordingArchiveNamespace } from "./recordingArchiveStore.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class RecordingArchiveCatalogError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
export interface RecordingArchiveCatalogRow {
  recordId: string; captureId: string; eventId: string; deviceId: string;
  source: RecordingManifest["source"]; startedAt: number; endedAt: number; totalBytes: number;
  manifestHash: string; manifestReference: string; processingPolicy: RecordingManifest["processingPolicy"];
  asrState: "not_requested" | "queued";
}
interface Snapshot { namespace: string; revision: string; lastSyncedAt: number; rows: RecordingArchiveCatalogRow[] }
export interface RecordingArchiveCatalogOptions {
  stateDir: string;
  resolveOwner(owner: string): Promise<RecordingArchiveNamespace>;
  store: { getManifest(owner: string, recordId: string): Promise<RecordingManifest> };
  workerId(): string;
  clock?: () => number;
}
export interface RecordingArchiveCatalogQuery { cursor?: string; limit?: number; from?: number; to?: number; source?: RecordingManifest["source"] }
/** Rebuildable local projection. No list request enumerates NAS manifests or creates an archive. */
export class RecordingArchiveCatalog {
  private snapshots = new Map<string, Snapshot>();
  private locks = new Map<string, Promise<unknown>>();
  private secret?: Promise<Buffer>;
  constructor(private readonly options: RecordingArchiveCatalogOptions) {}
  private now() { return (this.options.clock ?? Date.now)(); }
  private identity(owner: string) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new RecordingArchiveCatalogError("invalid_owner", 400); }
  private file(owner: string) { return path.join(this.options.stateDir, "recording-archive-catalog", hash(owner) + ".json"); }
  private async atomic(file: string, value: unknown) {
    return auditRecordingArchiveMutation("recording-archive-catalog", file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + "." + randomUUID() + ".partial";
      try { const h = await fs.open(tmp, "wx"); try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); } await fs.rename(tmp, file); }
      finally { await fs.rm(tmp, { force: true }); }
    });
  }
  private key() {
    return this.secret ??= (async () => {
      const file = path.join(this.options.stateDir, "recording-archive-catalog", "cursor.key");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await auditRecordingArchiveMutation("recording-archive-cursor-key", file, async () => {
        try { await fs.writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 }); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; }
      });
      const key = await fs.readFile(file); if (key.length !== 32) throw new Error("Invalid catalog cursor key"); return key;
    })();
  }
  private async serial<T>(owner: string, action: () => Promise<T>): Promise<T> {
    this.identity(owner); const prev = this.locks.get(owner) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(action); this.locks.set(owner, next);
    try { return await next; } finally { if (this.locks.get(owner) === next) this.locks.delete(owner); }
  }
  private async target(owner: string) {
    const target = await this.options.resolveOwner(owner);
    if (!path.isAbsolute(target.root)) throw new RecordingArchiveCatalogError("invalid_namespace", 409);
    const root = await fs.lstat(target.root), file = path.join(target.root, "namespace.json");
    if (!root.isDirectory() || root.isSymbolicLink()) throw new RecordingArchiveCatalogError("invalid_namespace", 409);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new RecordingArchiveCatalogError("invalid_namespace", 409);
    const marker = JSON.parse(await fs.readFile(file, "utf8"));
    if (marker.schemaVersion !== 1 || marker.storageNamespaceId !== target.storageNamespaceId) throw new RecordingArchiveCatalogError("namespace_changed", 409);
    return target;
  }
  private row(manifest: RecordingManifest): RecordingArchiveCatalogRow {
    return { recordId: manifest.recordId, captureId: manifest.captureId, eventId: manifest.eventId, deviceId: manifest.deviceId,
      source: manifest.source, startedAt: manifest.startedAt, endedAt: manifest.endedAt, totalBytes: manifest.totalBytes,
      manifestHash: recordingManifestHash(manifest), manifestReference: `/recordings/${manifest.recordId}/manifest`,
      processingPolicy: manifest.processingPolicy, asrState: manifest.processingPolicy === "local_only" ? "not_requested" : "queued" };
  }
  private compare(a: RecordingArchiveCatalogRow, b: RecordingArchiveCatalogRow) { return a.startedAt - b.startedAt || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0); }
  private async save(owner: string, snapshot: Snapshot) {
    this.snapshots.set(owner, snapshot);
    // Cache failure cannot invalidate NAS commit or the in-memory projection.
    try { await this.atomic(this.file(owner), { schemaVersion: 1, ownerHash: hash(owner), ...snapshot }); } catch { /* rebuild from immutable manifests */ }
  }
  async onCommitted(owner: string, input: RecordingManifest, receipt: ArchiveReceipt): Promise<void> {
    await this.serial(owner, async () => {
      const target = await this.target(owner), manifest = validateRecordingManifest(input);
      if (manifest.deviceId !== owner) throw new RecordingArchiveCatalogError("owner_mismatch", 403);
      validateArchiveReceipt(receipt, { workerId: this.options.workerId(), storageNamespaceId: target.storageNamespaceId, manifest });
      const old = this.snapshots.get(owner);
      // A commit hint must not create a misleading partial catalog before explicit recovery.
      if (!old) throw new RecordingArchiveCatalogError("catalog_not_ready", 503);
      if (old.namespace !== target.storageNamespaceId) throw new RecordingArchiveCatalogError("namespace_changed", 409);
      const row = this.row(manifest), previous = old.rows.find(x => x.recordId === row.recordId);
      if (previous && previous.manifestHash !== row.manifestHash) throw new RecordingArchiveCatalogError("record_conflict", 409);
      if (previous) return;
      const rows = [...old.rows, row].sort((a, b) => this.compare(a, b));
      await this.save(owner, { namespace: old.namespace, revision: randomUUID(), lastSyncedAt: this.now(), rows });
    });
  }
  /** Explicit startup recovery; validates every immutable envelope sequentially, never audio objects. */
  async restore(owner: string) { return this.rebuild(owner); }
  async rebuild(owner: string): Promise<void> {
    await this.serial(owner, async () => {
      const target = await this.target(owner), rows: RecordingArchiveCatalogRow[] = [];
      const parent = path.join(target.root, "manifests"), directory = path.join(parent, hash(owner));
      let exists = true;
      for (const dir of [parent, directory]) {
        try { const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe catalog directory"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { exists = false; break; } throw e; }
      }
      if (exists) {
        for await (const entry of await fs.opendir(directory)) {
          if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          const file = path.join(directory, entry.name), stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid archive envelope");
          const value = JSON.parse(await fs.readFile(file, "utf8"));
          const manifest = validateRecordingManifest(value.manifest);
          if (value.schemaVersion !== 1 || value.ownerHash !== hash(owner) || manifest.deviceId !== owner || entry.name !== hash(manifest.recordId) + ".json") throw new Error("Archive envelope identity mismatch");
          validateArchiveReceipt(value.receipt, { workerId: this.options.workerId(), storageNamespaceId: target.storageNamespaceId, manifest });
          rows.push(this.row(manifest));
        }
      }
      const final = await this.target(owner);
      if (final.storageNamespaceId !== target.storageNamespaceId || path.resolve(final.root) !== path.resolve(target.root)) throw new RecordingArchiveCatalogError("namespace_changed", 409);
      rows.sort((a, b) => this.compare(a, b));
      await this.save(owner, { namespace: target.storageNamespaceId, revision: randomUUID(), lastSyncedAt: this.now(), rows });
    });
  }
  /** Optional offline startup cache; explicit, never triggered by list. Invalid cache is not empty history. */
  async restoreCache(owner: string, expectedNamespace: string): Promise<void> {
    await this.serial(owner, async () => {
      const value = JSON.parse(await fs.readFile(this.file(owner), "utf8"));
      if (value.schemaVersion !== 1 || value.ownerHash !== hash(owner) || value.namespace !== expectedNamespace || !Array.isArray(value.rows)
          || typeof value.revision !== "string" || !Number.isSafeInteger(value.lastSyncedAt)) throw new Error("Invalid catalog cache");
      for (const row of value.rows) {
        if (row.deviceId !== owner || !/^[A-Za-z0-9_-]{1,128}$/.test(row.recordId) || !/^[a-f0-9]{64}$/.test(row.manifestHash)
            || !Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.endedAt) || row.startedAt < 0 || row.endedAt < row.startedAt) throw new Error("Invalid catalog cache row");
      }
      value.rows.sort((a: RecordingArchiveCatalogRow, b: RecordingArchiveCatalogRow) => this.compare(a, b));
      this.snapshots.set(owner, { namespace: value.namespace, revision: value.revision, lastSyncedAt: value.lastSyncedAt, rows: value.rows });
    });
  }
  async list(owner: string, query: RecordingArchiveCatalogQuery = {}) {
    this.identity(owner);
    const limit = query.limit ?? 50, from = query.from ?? 0, to = query.to ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from
        || query.source !== undefined && !["phone", "glasses", "video"].includes(query.source)) throw new RecordingArchiveCatalogError("invalid_query", 400);
    const snapshot = this.snapshots.get(owner); if (!snapshot) throw new RecordingArchiveCatalogError("catalog_not_ready", 503);
    let offline = false;
    // Resolver failures are authorization/configuration failures, never evidence of an offline NAS.
    const binding = await this.options.resolveOwner(owner);
    if (binding.storageNamespaceId !== snapshot.namespace) throw new RecordingArchiveCatalogError("namespace_changed", 409);
    try {
      const target = await this.target(owner);
      if (target.storageNamespaceId !== snapshot.namespace) throw new RecordingArchiveCatalogError("namespace_changed", 409);
    }
    catch (e) { if (e instanceof RecordingArchiveCatalogError || !["ENOENT", "ENOTCONN", "EHOSTUNREACH", "ETIMEDOUT", "EIO", "ENETUNREACH"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; offline = true; }
    const filter = JSON.stringify({ from, to, source: query.source ?? null });
    let after: { time: number; id: string } | undefined;
    const key = await this.key();
    if (query.cursor) {
      if (query.cursor.length > 4096) throw new RecordingArchiveCatalogError("invalid_cursor", 400);
      const [body, signature, extra] = query.cursor.split(".");
      const expected = createHmac("sha256", key).update(body ?? "").digest();
      const actual = Buffer.from(signature ?? "", "base64url");
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RecordingArchiveCatalogError("invalid_cursor", 400);
      let value; try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new RecordingArchiveCatalogError("invalid_cursor", 400); }
      if (value.owner !== hash(owner) || value.namespace !== snapshot.namespace || value.filter !== filter) throw new RecordingArchiveCatalogError("cursor_scope_mismatch", 403);
      if (value.revision !== snapshot.revision) throw new RecordingArchiveCatalogError("cursor_stale", 409);
      if (!Number.isSafeInteger(value.time) || typeof value.id !== "string") throw new RecordingArchiveCatalogError("invalid_cursor", 400);
      after = { time: value.time, id: value.id };
    }
    // Binary seek into the resident sorted index; only matching rows for this page are materialized.
    let lo = 0, hi = snapshot.rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1, row = snapshot.rows[mid];
      if (row.startedAt < from || after && (row.startedAt < after.time || row.startedAt === after.time && row.recordId <= after.id)) lo = mid + 1; else hi = mid; }
    const rows: RecordingArchiveCatalogRow[] = [];
    for (let i = lo; i < snapshot.rows.length && rows.length <= limit; i++) {
      const row = snapshot.rows[i]; if (row.startedAt > to) break;
      if (!query.source || row.source === query.source) rows.push(row);
    }
    const hasMore = rows.length > limit, items = rows.slice(0, limit).map(row => ({ ...row }));
    const last = items.at(-1); let nextCursor: string | null = null;
    if (hasMore && last) { const body = Buffer.from(JSON.stringify({ owner: hash(owner), namespace: snapshot.namespace, revision: snapshot.revision, filter, time: last.startedAt, id: last.recordId })).toString("base64url"); nextCursor = body + "." + createHmac("sha256", key).update(body).digest("base64url"); }
    return { items, nextCursor, snapshotRevision: snapshot.revision, storageNamespaceId: snapshot.namespace, offline, lastSyncedAt: snapshot.lastSyncedAt };
  }
}
