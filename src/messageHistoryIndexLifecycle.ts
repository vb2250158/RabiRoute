import { getTimeoutMs } from "./shared/timeoutSettings.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireFileLockSync, atomicWriteFileSync } from "./shared/filePersistence.js";

type IndexPointer = { schemaVersion: 1; generation: string; publishedAt: string };
type BuildPointer = { schemaVersion: 1; generation: string; startedAt: string; reason: string };
export type MessageIndexLease = { databasePath: string; generation: string; release(): void };
export type MessageIndexBuildResult = { records: number; filesRead: number };

const validGeneration = /^[a-f0-9-]{36}$/;
const heldLeases = new WeakSet<MessageIndexLease>();
const generationCleanupTimes = new Map<string, number>();

function collectGenerationsIfDue(indexPath: string, force = false): void {
  const key = path.resolve(indexPath); const now = performance.now();
  const previous = generationCleanupTimes.get(key);
  if (!force && previous !== undefined && now - previous < 30_000) return;
  collectGenerations(indexPath);
  generationCleanupTimes.delete(key); generationCleanupTimes.set(key, performance.now());
  while (generationCleanupTimes.size > 128) generationCleanupTimes.delete(generationCleanupTimes.keys().next().value!);
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function stateRoot(indexPath: string): string {
  const root = path.resolve(indexPath + ".state");
  for (const candidate of [root, path.join(root, "versions")]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error("MESSAGE_HISTORY_INDEX_POINTER_INVALID");
  }
  return root;
}

function generationRoot(indexPath: string, generation: string): string {
  if (!validGeneration.test(generation)) throw new Error("MESSAGE_HISTORY_INDEX_POINTER_INVALID");
  const root = path.join(stateRoot(indexPath), "versions", generation);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("MESSAGE_HISTORY_INDEX_POINTER_INVALID");
  return root;
}

function activePointer(indexPath: string): IndexPointer | undefined {
  const pointer = readJson<IndexPointer>(path.join(stateRoot(indexPath), "active.json"));
  if (pointer && (pointer.schemaVersion !== 1 || !validGeneration.test(pointer.generation))) {
    throw new Error("MESSAGE_HISTORY_INDEX_POINTER_INVALID");
  }
  return pointer;
}

/** Lease before opening SQLite; recheck the pointer so publication/GC cannot race the open. */
export function acquireMessageIndexLease(indexPath: string, retained: readonly MessageIndexLease[] = []): MessageIndexLease {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pointer = activePointer(indexPath);
    if (!pointer) {
      throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY");
    }
    const root = generationRoot(indexPath, pointer.generation);
    if (fs.existsSync(path.join(root, "quarantine.json"))) throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY");
    const databasePath = path.join(root, "index.sqlite");
    const existing = retained.find(lease => heldLeases.has(lease) && lease.generation === pointer.generation && lease.databasePath === databasePath);
    if (existing) {
      // The worker already pins this generation. Revalidate identity and health
      // without creating/deleting another lease file on every visibility probe.
      if (activePointer(indexPath)?.generation !== pointer.generation || !fs.existsSync(databasePath)) continue;
      return existing;
    }
    const leases = path.join(root, "leases");
    const leaseFile = path.join(leases, `${process.pid}-${randomUUID()}.json`);
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
    const release = () => { try { fs.unlinkSync(leaseFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
    if (activePointer(indexPath)?.generation !== pointer.generation || !fs.existsSync(path.join(root, "index.sqlite"))) {
      release(); continue;
    }
    const lease: MessageIndexLease = { databasePath, generation: pointer.generation, release() { release(); heldLeases.delete(lease); } };
    heldLeases.add(lease);
    return lease;
  }
  throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY");
}

function databaseCorrupt(error: unknown): boolean {
  const failure = error as { errcode?: number; message?: string };
  return failure.errcode === 11 || failure.errcode === 26
    || /malformed|not a database|INDEX_VERSION_MISMATCH|INDEX_INTEGRITY/.test(failure.message ?? "");
}

function validateDatabase(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY");
    db.exec("INSERT INTO terms(terms) VALUES('integrity-check')");
    const documents = Number(db.prepare("SELECT count(*) AS n FROM documents").get()!.n);
    const postings = Number(db.prepare("SELECT count(*) AS n FROM terms").get()!.n);
    const unowned = Number(db.prepare("SELECT count(*) AS n FROM documents d LEFT JOIN sources s ON s.file=d.source WHERE s.file IS NULL").get()!.n);
    if (documents !== postings || unowned || !db.prepare("SELECT value FROM meta WHERE key='snapshot'").get()) {
      throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
}

function markQuarantined(indexPath: string, generation: string, reason: string): void {
  const root = generationRoot(indexPath, generation);
  atomicWriteFileSync(path.join(root, "quarantine.json"), JSON.stringify({ reason, at: new Date().toISOString() }), { mode: 0o600 });
}

/** The detecting reader holds this generation's lease; no SQLite write or pointer switch occurs here. */
export function quarantineMessageIndexProjection(indexPath: string, generation: string): void {
  markQuarantined(indexPath, generation, "invalid_projection");
}

function hasLiveLeases(root: string): boolean {
  const leases = path.join(root, "leases");
  if (!fs.existsSync(leases)) return false;
  for (const file of fs.readdirSync(leases)) {
    if (!/^\d+-[a-f0-9-]{36}\.json$/.test(file)) return true;
    const leasePath = path.join(leases, file);
    const lease = readJson<{ pid: number }>(leasePath);
    if (!lease || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) return true;
    try { process.kill(lease.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
    fs.unlinkSync(leasePath);
  }
  return false;
}

/** Called under the single writer lock. Retain active, rollback and two damaged generations. */
function collectGenerations(indexPath: string): void {
  const root = path.join(stateRoot(indexPath), "versions");
  const active = activePointer(indexPath);
  const previous = readJson<IndexPointer>(path.join(stateRoot(indexPath), "previous.json"));
  const building = readJson<BuildPointer>(path.join(stateRoot(indexPath), "building.json"));
  const retained = new Set([active?.generation, previous?.generation, building?.generation]);
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && validGeneration.test(entry.name));
  const damaged = entries.filter(entry => fs.existsSync(path.join(root, entry.name, "quarantine.json")))
    .sort((a, b) => fs.statSync(path.join(root, b.name)).mtimeMs - fs.statSync(path.join(root, a.name)).mtimeMs);
  for (const entry of damaged.slice(0, 2)) retained.add(entry.name);
  for (const entry of entries) {
    const target = generationRoot(indexPath, entry.name);
    // Resolved target must remain inside this exact derived-cache versions directory.
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid index generation cleanup target");
    if (!retained.has(entry.name) && !hasLiveLeases(target)) fs.rmSync(target, { recursive: true });
  }
}

/** Construct/repair outside the active pointer, then publish only a validated complete database. */
export function refreshManagedMessageIndex<T extends MessageIndexBuildResult>(indexPath: string, refresh: (databasePath: string) => T,
  options: { rebuild?: boolean } = {}): T & { generation: string; rebuilt: boolean } {
  const root = stateRoot(indexPath);
  fs.mkdirSync(root, { recursive: true });
  const release = acquireFileLockSync(path.join(root, "writer.lock"), { timeoutMs: getTimeoutMs("backend.messageHistoryIndexLifecycle.refreshManagedMessageIndex.acquireFileLockSync.timeoutMs", 1_000), staleMs: 1_000 });
  try {
    let previous: IndexPointer | undefined;
    let previousHealthy = true;
    try { previous = activePointer(indexPath); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "MESSAGE_HISTORY_INDEX_POINTER_INVALID")) throw error;
      const damaged = path.join(root, "active.json");
      fs.copyFileSync(damaged, path.join(root, `pointer-quarantine-${randomUUID()}.json`), fs.constants.COPYFILE_EXCL);
      previousHealthy = false;
    }
    if (previous && fs.existsSync(path.join(generationRoot(indexPath, previous.generation), "quarantine.json"))) previousHealthy = false;
    if (previous && previousHealthy && !options.rebuild) {
      try {
        const database = path.join(generationRoot(indexPath, previous.generation), "index.sqlite");
        if (!fs.existsSync(database)) throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY: missing database");
        const result = refresh(database);
        collectGenerationsIfDue(indexPath);
        return { ...result, generation: previous.generation, rebuilt: false };
      } catch (error) {
        if (!databaseCorrupt(error)) throw error;
        markQuarantined(indexPath, previous.generation, "database_corrupt");
        previousHealthy = false;
      }
    }
    let building: BuildPointer | undefined;
    try { building = readJson<BuildPointer>(path.join(root, "building.json")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      fs.copyFileSync(path.join(root, "building.json"), path.join(root, `pointer-quarantine-${randomUUID()}.json`), fs.constants.COPYFILE_EXCL);
    }
    if (!building || !validGeneration.test(building.generation)) {
      building = { schemaVersion: 1, generation: randomUUID(), startedAt: new Date().toISOString(), reason: previous ? "rebuild" : "initial" };
      atomicWriteFileSync(path.join(root, "building.json"), JSON.stringify(building), { mode: 0o600 });
    }
    const candidate = path.join(generationRoot(indexPath, building.generation), "index.sqlite");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    let result: T;
    try { result = refresh(candidate); validateDatabase(candidate); }
    catch (error) {
      if (databaseCorrupt(error)) {
        markQuarantined(indexPath, building.generation, "candidate_corrupt");
        fs.unlinkSync(path.join(root, "building.json"));
      }
      throw error;
    }
    const pointer: IndexPointer = { schemaVersion: 1, generation: building.generation, publishedAt: new Date().toISOString() };
    if (previous && previousHealthy) atomicWriteFileSync(path.join(root, "previous.json"), JSON.stringify(previous), { mode: 0o600 });
    atomicWriteFileSync(path.join(root, "active.json"), JSON.stringify(pointer), { mode: 0o600 });
    fs.unlinkSync(path.join(root, "building.json"));
    collectGenerationsIfDue(indexPath, true);
    return { ...result, generation: pointer.generation, rebuilt: true };
  } finally { release(); }
}

export function collectMessageIndexGenerations(indexPath: string): void {
  const release = acquireFileLockSync(path.join(stateRoot(indexPath), "writer.lock"), { timeoutMs: getTimeoutMs("backend.messageHistoryIndexLifecycle.collectMessageIndexGenerations.acquireFileLockSync.timeoutMs", 1_000) });
  try { collectGenerationsIfDue(indexPath, true); } finally { release(); }
}

/** Compare-and-swap rollback of derived data only; ordinary reads still enforce source freshness. */
export function rollbackMessageIndex(indexPath: string, expectedGeneration: string): string {
  const root = stateRoot(indexPath);
  const release = acquireFileLockSync(path.join(root, "writer.lock"), { timeoutMs: getTimeoutMs("backend.messageHistoryIndexLifecycle.rollbackMessageIndex.acquireFileLockSync.timeoutMs", 1_000) });
  try {
    const active = activePointer(indexPath);
    if (!active || active.generation !== expectedGeneration) throw new Error("MESSAGE_HISTORY_INDEX_ROLLBACK_CONFLICT");
    const previous = readJson<IndexPointer>(path.join(root, "previous.json"));
    if (!previous || previous.schemaVersion !== 1 || !validGeneration.test(previous.generation)) throw new Error("MESSAGE_HISTORY_INDEX_ROLLBACK_UNAVAILABLE");
    const candidateRoot = generationRoot(indexPath, previous.generation);
    if (fs.existsSync(path.join(candidateRoot, "quarantine.json"))) throw new Error("MESSAGE_HISTORY_INDEX_ROLLBACK_UNAVAILABLE");
    validateDatabase(path.join(candidateRoot, "index.sqlite"));
    // Retain both before changing the single authoritative serving pointer.
    atomicWriteFileSync(path.join(root, "previous.json"), JSON.stringify(active), { mode: 0o600 });
    atomicWriteFileSync(path.join(root, "active.json"), JSON.stringify(previous), { mode: 0o600 });
    return previous.generation;
  } finally { release(); }
}
