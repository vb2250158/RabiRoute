import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalPlanStorageKey } from "./planStorageIdentity.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";

// Physical rotation only: plan archival remains a separate lifecycle operation.
export const PLAN_HISTORY_FILE = "history.jsonl";
export const PLAN_HISTORY_FILE_LIMIT = 16 * 1024 * 1024;
const SHARD_NAME = /^history\/(\d{6})\.jsonl$/;

export function isPlanHistoryPath(relativePath: string): boolean {
  return relativePath === PLAN_HISTORY_FILE || relativePath.startsWith("history/");
}

/** Return physical files in append order, refusing gaps and unknown files in the reserved directory. */
export function orderedPlanHistoryPaths(paths: Iterable<string>): string[] {
  const all = [...paths];
  const shards = all.filter(file => file.startsWith("history/"));
  if (!all.includes(PLAN_HISTORY_FILE)) {
    if (shards.length) throw new Error("Plan history shards require history.jsonl.");
    return [];
  }
  const numbered = shards.map(file => {
    const match = SHARD_NAME.exec(file);
    if (!match || Number(match[1]) < 1) throw new Error(`Invalid plan history shard: ${file}`);
    return { file, number: Number(match[1]) };
  }).sort((left, right) => left.number - right.number);
  numbered.forEach(({ file, number }, index) => {
    if (number !== index + 1) throw new Error(`Plan history shard is missing or duplicated before: ${file}`);
  });
  return [PLAN_HISTORY_FILE, ...numbered.map(({ file }) => file)];
}

/** The envelope belongs to storage, not to the plan's audit snapshots. */
export function setPlanHistoryCommitment(plan: Record<string, unknown>, files: Map<string, Buffer>): Record<string, unknown> {
  const paths = orderedPlanHistoryPaths(files.keys());
  if (!paths.length) throw new Error("Plan history commitment requires a base file.");
  const shards = paths.map(file => {
    const content = files.get(file)!;
    if (!content.byteLength) throw new Error(`Plan history file is empty: ${file}`);
    return { path: file, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
  });
  const { historyCommitment: _previous, ...body } = plan;
  return { ...body, historyCommitment: { schemaVersion: 1, shards } };
}

export function validatePlanHistoryCommitment(plan: Record<string, unknown>, files: Map<string, Buffer>): void {
  const paths = orderedPlanHistoryPaths(files.keys());
  const value = plan.historyCommitment;
  // Old uncommitted data has no promise to verify; do not invent one on reads.
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plan history commitment.");
  const commitment = value as { schemaVersion?: unknown; shards?: unknown };
  if (commitment.schemaVersion !== 1 || !Array.isArray(commitment.shards) || !commitment.shards.length || commitment.shards.length !== paths.length) {
    throw new Error("Plan history commitment shard count mismatch.");
  }
  for (const [index, shard] of commitment.shards.entries()) {
    const file = paths[index]!;
    if (!shard || typeof shard !== "object" || shard.path !== file || !Number.isSafeInteger(shard.bytes) || shard.bytes < 1
      || typeof shard.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(shard.sha256)) {
      throw new Error(`Plan history commitment metadata mismatch: ${file}`);
    }
    const bytes = files.get(file)!;
    if (bytes.byteLength !== shard.bytes || createHash("sha256").update(bytes).digest("hex") !== shard.sha256) {
      throw new Error(`Plan history commitment bytes or hash mismatch: ${file}`);
    }
  }
}

export function readPlanHistoryBytes(files: Map<string, Buffer>): Buffer {
  const paths = orderedPlanHistoryPaths(files.keys());
  // A legacy base file may contain a complete last JSON row without LF. Treat
  // the physical shard boundary as a logical line break without changing old bytes.
  const chunks: Buffer[] = [];
  for (const file of paths) {
    const previous = chunks.at(-1);
    if (previous?.byteLength && previous.at(-1) !== 10) chunks.push(Buffer.from("\n"));
    chunks.push(files.get(file)!);
  }
  return Buffer.concat(chunks);
}

export function appendPlanHistoryRecord(files: Map<string, Buffer>, record: unknown): void {
  const row = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (row.byteLength > PLAN_HISTORY_FILE_LIMIT) throw new Error("Plan history record exceeds the per-file limit.");
  const paths = orderedPlanHistoryPaths(files.keys());
  const latest = paths.at(-1) ?? PLAN_HISTORY_FILE;
  const current = files.get(latest) ?? Buffer.alloc(0);
  const separator = current.byteLength && current.at(-1) !== 10 ? Buffer.from("\n") : Buffer.alloc(0);
  if (current.byteLength + separator.byteLength + row.byteLength <= PLAN_HISTORY_FILE_LIMIT) {
    files.set(latest, Buffer.concat([current, separator, row]));
    return;
  }
  if (!current.byteLength) throw new Error("Plan history base must contain a complete record.");
  const next = `history/${String(paths.length).padStart(6, "0")}.jsonl`;
  if (paths.length > 999999 || files.has(next)) throw new Error("Plan history shard capacity exceeded.");
  files.set(next, row);
}

function existingHistoryEntry(location: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link is an occupied entry even though existsSync reports false.
      const parent = path.dirname(location);
      try {
        if (fs.readdirSync(parent).includes(path.basename(location))) {
          throw new Error(`Invalid plan history entry: ${location}`);
        }
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
      }
      return undefined;
    }
    throw error;
  }
}

export async function readPlanHistoryDirectoryAsync(directory: string, signal?: AbortSignal): Promise<Map<string, Buffer>> {
  const stat = async (file: string) => {
    try { return await fs.promises.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  signal?.throwIfAborted();
  const files = new Map<string, Buffer>();
  const owner = await stat(directory);
  if (!owner) return files;
  if (!owner.isDirectory()) throw new Error(`Invalid plan history owner directory: ${directory}`);
  const base = path.join(directory, PLAN_HISTORY_FILE), baseEntry = await stat(base);
  if (baseEntry) {
    if (!baseEntry.isFile()) throw new Error(`Invalid plan history base: ${base}`);
    files.set(PLAN_HISTORY_FILE, await fs.promises.readFile(base, { signal }));
  }
  const shards = path.join(directory, "history"), shardEntry = await stat(shards);
  if (shardEntry) {
    if (!shardEntry.isDirectory()) throw new Error(`Invalid plan history directory: ${shards}`);
    for (const entry of await fs.promises.readdir(shards, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Invalid plan history shard: ${entry.name}`);
      files.set(`history/${entry.name}`, await fs.promises.readFile(path.join(shards, entry.name), { signal }));
    }
  }
  signal?.throwIfAborted();
  orderedPlanHistoryPaths(files.keys());
  return files;
}

export function readPlanHistoryDirectory(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const owner = existingHistoryEntry(directory);
  if (owner && !owner.isDirectory()) throw new Error(`Invalid plan history owner directory: ${directory}`);
  if (!owner) return files;
  const base = path.join(directory, PLAN_HISTORY_FILE);
  const baseEntry = existingHistoryEntry(base);
  if (baseEntry) {
    if (!baseEntry.isFile()) throw new Error(`Invalid plan history base: ${base}`);
    files.set(PLAN_HISTORY_FILE, fs.readFileSync(base));
  }
  const shardDirectory = path.join(directory, "history");
  const shardEntry = existingHistoryEntry(shardDirectory);
  if (shardEntry) {
    if (!shardEntry.isDirectory()) throw new Error(`Invalid plan history directory: ${shardDirectory}`);
    for (const entry of fs.readdirSync(shardDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Invalid plan history shard: ${entry.name}`);
      files.set(`history/${entry.name}`, fs.readFileSync(path.join(shardDirectory, entry.name)));
    }
  }
  orderedPlanHistoryPaths(files.keys());
  return files;
}

const HISTORY_TRANSACTION_KINDS = ["plan-feedback", "plan-feedback-revision"] as const;

/** Snapshot feedback WAL publication for a physical plan bucket. */
function scanLegacyPlanStorageTransactionFence(
  roleDir: string,
  storageId: string,
  except?: { kind: "plan-feedback" | "plan-feedback-revision"; transactionId: string }
): string {
  if (canonicalPlanStorageKey(storageId) !== storageId) throw new Error(`Invalid plan storage key: ${storageId}`);
  const root = path.join(roleDir, "plans", "quarantine", "plan-storage-transactions", storageId);
  const owner = existingHistoryEntry(root);
  if (!owner) return "absent";
  if (!owner.isDirectory()) throw new Error(`Invalid plan history transaction root: ${root}`);
  const snapshots: string[] = [];
  for (const kind of fs.readdirSync(root).sort()) {
    if (!HISTORY_TRANSACTION_KINDS.includes(kind as typeof HISTORY_TRANSACTION_KINDS[number])) {
      throw new Error(`Unknown plan history transaction kind: ${kind}`);
    }
    const kindRoot = path.join(root, kind);
    const kindEntry = fs.lstatSync(kindRoot);
    if (!kindEntry.isDirectory()) throw new Error(`Invalid plan history transaction kind: ${kindRoot}`);
    for (const transactionId of fs.readdirSync(kindRoot).sort()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) {
        throw new Error(`Invalid plan history transaction id: ${transactionId}`);
      }
      const transactionRoot = path.join(kindRoot, transactionId);
      if (!fs.lstatSync(transactionRoot).isDirectory()) {
        throw new Error(`Invalid plan history transaction directory: ${transactionRoot}`);
      }
      const manifestPath = path.join(transactionRoot, "manifest.json");
      const manifest = existingHistoryEntry(manifestPath);
      if (!manifest) {
        // The writer stages payload before manifest publication; no canonical
        // file can change until its manifest is durable.
        continue;
      }
      if (!manifest.isFile()) throw new Error(`Invalid plan history transaction manifest: ${manifestPath}`);
      const receiptPath = path.join(transactionRoot, "receipt.json");
      const receipt = existingHistoryEntry(receiptPath);
      if (!receipt?.isFile()) {
        if (except?.kind !== kind || except.transactionId !== transactionId || receipt) {
          throw new Error(`Plan history has a pending feedback transaction: ${transactionRoot}`);
        }
        // Only the owner resuming this exact prepared transaction may proceed.
        // Keep its immutable manifest identity in the token, so a replacement
        // between two checks cannot silently change the permitted operation.
        const manifestBytes = fs.readFileSync(manifestPath);
        const value = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
        if (value.kind !== "plan_storage_repository_transaction" || value.status !== "prepared"
          || value.transactionKind !== kind || value.transactionId !== transactionId
          || typeof value.planId !== "string" || canonicalPlanStorageKey(value.planId) !== storageId
          || value.storageId !== storageId) {
          throw new Error(`Invalid plan history transaction manifest: ${manifestPath}`);
        }
        snapshots.push(`${kind}/${transactionId}:pending:${createHash("sha256").update(manifestBytes).digest("hex")}`);
        continue;
      }
      // Detect a transaction crossing the read even when its receipt is published
      // before the second fence check. The manifest is immutable once published.
      const receiptBytes = fs.readFileSync(receiptPath);
      const value = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
      if (value.kind !== "plan_storage_repository_transaction_receipt" || value.status !== "committed"
        || value.transactionKind !== kind || value.transactionId !== transactionId
        || typeof value.planId !== "string" || canonicalPlanStorageKey(value.planId) !== storageId
        || value.storageId !== storageId) {
        throw new Error(`Invalid plan history transaction receipt: ${receiptPath}`);
      }
      snapshots.push(`${kind}/${transactionId}:${createHash("sha256").update(receiptBytes).digest("hex")}`);
    }
  }
  return snapshots.join("|");
}

/** Snapshot the feedback WAL fence before and after reading one logical plan. */
export function planHistoryTransactionFence(roleDir: string, planId: string): string {
  const storageId = canonicalPlanStorageKey(planId);
  const snapshot = planStorageTransactionFence(roleDir, storageId);
  // The physical bucket can collide with another logical id; both identities
  // must observe the same publication fence for that bucket.
  return snapshot;
}

/** Async point-read fence; does not block the manager event loop on storage I/O. */
async function scanLegacyPlanHistoryTransactionFenceAsync(roleDir: string, planId: string, signal?: AbortSignal): Promise<string> {
  const storageId = canonicalPlanStorageKey(planId);
  const root = path.join(roleDir, "plans", "quarantine", "plan-storage-transactions", storageId);
  signal?.throwIfAborted();
  let owner: fs.Stats;
  try { owner = await fs.promises.lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  if (!owner.isDirectory()) throw new Error(`Invalid plan history transaction root: ${root}`);
  const snapshots: string[] = [];
  for (const kind of (await fs.promises.readdir(root)).sort()) {
    signal?.throwIfAborted();
    if (!HISTORY_TRANSACTION_KINDS.includes(kind as typeof HISTORY_TRANSACTION_KINDS[number])) throw new Error(`Unknown plan history transaction kind: ${kind}`);
    const kindRoot = path.join(root, kind);
    if (!(await fs.promises.lstat(kindRoot)).isDirectory()) throw new Error(`Invalid plan history transaction kind: ${kindRoot}`);
    for (const transactionId of (await fs.promises.readdir(kindRoot)).sort()) {
      signal?.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) throw new Error(`Invalid plan history transaction id: ${transactionId}`);
      const transactionRoot = path.join(kindRoot, transactionId);
      if (!(await fs.promises.lstat(transactionRoot)).isDirectory()) throw new Error(`Invalid plan history transaction directory: ${transactionRoot}`);
      const manifestPath = path.join(transactionRoot, "manifest.json");
      let manifest: fs.Stats;
      try { manifest = await fs.promises.lstat(manifestPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!manifest.isFile()) throw new Error(`Invalid plan history transaction manifest: ${manifestPath}`);
      const receiptPath = path.join(transactionRoot, "receipt.json");
      let receipt: fs.Stats;
      try { receipt = await fs.promises.lstat(receiptPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Plan history has a pending feedback transaction: ${transactionRoot}`); throw error; }
      if (!receipt.isFile()) throw new Error(`Invalid plan history transaction receipt: ${receiptPath}`);
      const bytes = await fs.promises.readFile(receiptPath, { signal });
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (value.kind !== "plan_storage_repository_transaction_receipt" || value.status !== "committed"
        || value.transactionKind !== kind || value.transactionId !== transactionId || typeof value.planId !== "string"
        || canonicalPlanStorageKey(value.planId) !== storageId || value.storageId !== storageId) throw new Error(`Invalid plan history transaction receipt: ${receiptPath}`);
      snapshots.push(`${kind}/${transactionId}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  return snapshots.join("|");
}

type HistoryWalState = { schemaVersion: 1; generation: string; active: null | { kind: "plan-feedback" | "plan-feedback-revision"; transactionId: string } };
const legacyFenceCache = new Map<string, string>();
function rememberLegacyFence(key: string, value: string): void {
  legacyFenceCache.delete(key);
  legacyFenceCache.set(key, value);
  if (legacyFenceCache.size > 8192) legacyFenceCache.delete(legacyFenceCache.keys().next().value!);
}
function historyWalStatePath(roleDir: string, storageId: string): string {
  return path.join(roleDir, "plans", "quarantine", "plan-storage-active-wal", `${storageId}.json`);
}
function parseHistoryWalState(text: string): HistoryWalState {
  const value = JSON.parse(text) as HistoryWalState;
  if (value?.schemaVersion !== 1 || typeof value.generation !== "string" || !/^[a-f0-9-]{36}$/.test(value.generation)
    || (value.active !== null && (!value.active || !HISTORY_TRANSACTION_KINDS.includes(value.active.kind)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(value.active.transactionId)))) throw new Error("Invalid plan history active WAL state.");
  return value;
}
function readHistoryWalState(roleDir: string, storageId: string): string | undefined {
  const file = historyWalStatePath(roleDir, storageId), entry = existingHistoryEntry(file);
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error(`Invalid plan history active WAL state: ${file}`);
  return fs.readFileSync(file, "utf8");
}
function checkActiveWal(roleDir: string, storageId: string, text: string | undefined,
  except?: { kind: "plan-feedback" | "plan-feedback-revision"; transactionId: string }): void {
  if (!text) return;
  const active = parseHistoryWalState(text).active;
  if (!active || (except?.kind === active.kind && except.transactionId === active.transactionId)) return;
  const receipt = path.join(roleDir, "plans", "quarantine", "plan-storage-transactions", storageId, active.kind, active.transactionId, "receipt.json");
  const entry = existingHistoryEntry(receipt);
  if (!entry?.isFile()) throw new Error(`Plan history has a pending feedback transaction: ${active.transactionId}`);
  const value = JSON.parse(fs.readFileSync(receipt, "utf8")) as Record<string, unknown>;
  if (value.kind !== "plan_storage_repository_transaction_receipt" || value.status !== "committed"
    || value.transactionKind !== active.kind || value.transactionId !== active.transactionId || value.storageId !== storageId
    || typeof value.planId !== "string" || canonicalPlanStorageKey(value.planId) !== storageId) throw new Error("Invalid plan history active WAL receipt.");
}
/** Called only by the existing per-plan lease owner before staging or applying WAL. */
export function publishPlanHistoryWalState(roleDir: string, storageId: string,
  active: HistoryWalState["active"]): void {
  const file = historyWalStatePath(roleDir, storageId);
  const previous = readHistoryWalState(roleDir, storageId);
  if (active) checkActiveWal(roleDir, storageId, previous, active);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify({ schemaVersion: 1, generation: randomUUID(), active })}\n`);
}

export function planStorageTransactionFence(roleDir: string, storageId: string,
  except?: { kind: "plan-feedback" | "plan-feedback-revision"; transactionId: string }): string {
  const key = `${path.resolve(roleDir)}\0${storageId}`;
  const before = readHistoryWalState(roleDir, storageId);
  checkActiveWal(roleDir, storageId, before, except);
  let legacy = legacyFenceCache.get(key);
  if (legacy === undefined) {
    const scanned = scanLegacyPlanStorageTransactionFence(roleDir, storageId, except);
    if (!except) { legacy = createHash("sha256").update(scanned).digest("hex"); rememberLegacyFence(key, legacy); }
    else legacy = createHash("sha256").update(scanned).digest("hex");
  }
  const after = readHistoryWalState(roleDir, storageId);
  if (after !== before) throw new Error("Plan history transaction changed during read.");
  return `${legacy}:${before ?? "absent"}`;
}

export async function planHistoryTransactionFenceAsync(roleDir: string, planId: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const storageId = canonicalPlanStorageKey(planId), key = `${path.resolve(roleDir)}\0${storageId}`;
  const file = historyWalStatePath(roleDir, storageId);
  const readState = async (): Promise<string | undefined> => {
    try { const stat = await fs.promises.lstat(file); if (!stat.isFile()) throw new Error(`Invalid plan history active WAL state: ${file}`); return await fs.promises.readFile(file, { encoding: "utf8", signal }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const before = await readState();
  if (before) {
    const active = parseHistoryWalState(before).active;
    if (active) {
      const receipt = path.join(roleDir, "plans", "quarantine", "plan-storage-transactions", storageId, active.kind, active.transactionId, "receipt.json");
      let bytes: string;
      try { const stat = await fs.promises.lstat(receipt); if (!stat.isFile()) throw new Error("Invalid plan history active WAL receipt."); bytes = await fs.promises.readFile(receipt, { encoding: "utf8", signal }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Plan history has a pending feedback transaction: ${active.transactionId}`); throw error; }
      const value = JSON.parse(bytes) as Record<string, unknown>;
      if (value.kind !== "plan_storage_repository_transaction_receipt" || value.status !== "committed" || value.transactionKind !== active.kind
        || value.transactionId !== active.transactionId || value.storageId !== storageId || typeof value.planId !== "string"
        || canonicalPlanStorageKey(value.planId) !== storageId) throw new Error("Invalid plan history active WAL receipt.");
    }
  }
  let legacy = legacyFenceCache.get(key);
  if (legacy === undefined) {
    legacy = createHash("sha256").update(await scanLegacyPlanHistoryTransactionFenceAsync(roleDir, planId, signal)).digest("hex");
    rememberLegacyFence(key, legacy);
  }
  if (await readState() !== before) throw new Error("Plan history transaction changed during read.");
  return `${legacy}:${before ?? "absent"}`;
}
