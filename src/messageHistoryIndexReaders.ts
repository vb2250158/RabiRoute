import { DatabaseSync } from "node:sqlite";
import { acquireMessageIndexLease, type MessageIndexLease } from "./messageHistoryIndexLifecycle.js";

type Reader = { db: DatabaseSync; lease: MessageIndexLease };
const readers = new Map<string, Reader>();
let exitHook = false;

function close(reader: Reader): void { try { reader.db.close(); } finally { reader.lease.release(); } }

/** Worker-local LRU connections retain page caches and prevent last-close WAL churn. */
export function openMessageHistoryReader(indexPath: string): { db: DatabaseSync; generation: string; finish(): void } {
  const cached = process.env.RABIROUTE_MANAGER_READ_PROCESS === "1";
  const lease = acquireMessageIndexLease(indexPath, cached ? [...readers.values()].map(reader => reader.lease) : []);
  const prior = cached ? readers.get(lease.databasePath) : undefined;
  if (prior) {
    if (lease !== prior.lease) lease.release();
    readers.delete(lease.databasePath); readers.set(lease.databasePath, prior);
    return { db: prior.db, generation: prior.lease.generation, finish() {} };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(lease.databasePath, { readOnly: true });
    // Bound each retained connection to a 16 MiB SQLite page-cache target.
    // Two workers with four cached generations each target at most 128 MiB.
    db.exec("PRAGMA cache_size=-16384");
  }
  catch (error) { try { db?.close(); } finally { lease.release(); } throw error; }
  const reader = { db, lease };
  if (!cached) return { db, generation: lease.generation, finish: () => close(reader) };
  if (!exitHook) { process.once("exit", closeMessageHistoryReaders); exitHook = true; }
  readers.set(lease.databasePath, reader);
  if (readers.size > 4) {
    const oldest = readers.keys().next().value!;
    const retired = readers.get(oldest)!; readers.delete(oldest); close(retired);
  }
  return { db, generation: lease.generation, finish() {} };
}

export function closeMessageHistoryReaders(): void {
  for (const [key, reader] of readers) { readers.delete(key); close(reader); }
}
