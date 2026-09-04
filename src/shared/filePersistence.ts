import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

export type AtomicWriteFileOptions = {
  maxRenameAttempts?: number;
  retryDelayMs?: number;
  mode?: number;
  renameSync?: (source: string, destination: string) => void;
};

type FileLockRecord = {
  owner?: string;
  host?: string;
  pid?: number;
  createdAt?: number;
};

function readFileLockRecord(lockPath: string): FileLockRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8")) as FileLockRecord;
  } catch {
    return null;
  }
}

function sameHostProcessAlive(record: FileLockRecord | null): boolean {
  if (!record?.host || record.host.toLowerCase() !== os.hostname().toLowerCase()
    || !Number.isInteger(record.pid) || Number(record.pid) <= 0) return false;
  try {
    process.kill(Number(record.pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reclaimStaleFileLock(lockPath: string, staleMs: number): boolean {
  try {
    const before = fs.statSync(lockPath);
    const record = readFileLockRecord(lockPath);
    if (sameHostProcessAlive(record) || Date.now() - before.mtimeMs < staleMs) return false;
    const owner = String(record?.owner || "");
    const afterRecord = readFileLockRecord(lockPath);
    const after = fs.statSync(lockPath);
    if (String(afterRecord?.owner || "") !== owner
      || after.mtimeMs !== before.mtimeMs
      || after.size !== before.size) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function releaseOwnedFileLock(lockPath: string, owner: string): void {
  try {
    if (readFileLockRecord(lockPath)?.owner === owner) fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isWindowsExclusiveCreateContention(error: unknown, lockPath: string): boolean {
  const failure = error as NodeJS.ErrnoException;
  return process.platform === "win32"
    && failure.code === "EPERM"
    && failure.syscall === "open"
    && typeof failure.path === "string"
    && path.resolve(failure.path) === path.resolve(lockPath);
}

export function withFileLockSync<T>(
  lockPath: string,
  action: () => T,
  options: FileLockOptions = {}
): T {
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 5_000));
  const staleMs = Math.max(timeoutMs, Math.floor(options.staleMs ?? 30_000));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ owner, host: os.hostname(), pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      break;
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code || "");
      const windowsExclusiveCreateContention = isWindowsExclusiveCreateContention(error, lockPath);
      if (code !== "EEXIST" && !windowsExclusiveCreateContention) throw error;
      if (reclaimStaleFileLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      Atomics.wait(lockWaitBuffer, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    releaseOwnedFileLock(lockPath, owner);
  }
}

function transientRenameError(error: unknown): boolean {
  return new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]).has(
    String((error as NodeJS.ErrnoException).code || "")
  );
}

export function atomicWriteFileSync(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteFileOptions = {}
): void {
  const startedAt = Date.now();
  const targetId = path.basename(filePath);
  let beforeRevision: string | undefined;
  try {
    const current = fs.statSync(filePath);
    beforeRevision = `${current.size}:${Math.floor(current.mtimeMs)}`;
  } catch {
    beforeRevision = undefined;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
  // Windows readers may briefly hold a destination without FILE_SHARE_DELETE.
  // Keep the old file intact and retry the atomic rename for a bounded window;
  // never unlink the destination as a fallback because that creates a visible gap.
  const maxRenameAttempts = Math.max(1, Math.floor(options.maxRenameAttempts ?? 24));
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 25));
  const renameSync = options.renameSync ?? fs.renameSync;
  try {
    const descriptor = fs.openSync(temporary, "wx", options.mode ?? 0o666);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        renameSync(temporary, filePath);
        break;
      } catch (error) {
        if (attempt >= maxRenameAttempts || !transientRenameError(error)) throw error;
        const delay = Math.min(250, retryDelayMs * (2 ** Math.min(6, attempt - 1)));
        Atomics.wait(lockWaitBuffer, 0, 0, delay);
      }
    }
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    recordDataMutationAudit({
      group: "storage",
      event: "atomic_file_replaced",
      owner: "file-persistence",
      action: beforeRevision ? "replace" : "create",
      target: { type: "file", id: targetId },
      dataSource: { kind: "file", id: targetId },
      outcome: "committed",
      before: beforeRevision ? { revision: beforeRevision } : undefined,
      after: { digest: createHash("sha256").update(bytes).digest("hex") },
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "storage",
      event: "atomic_file_replace_failed",
      owner: "file-persistence",
      action: beforeRevision ? "replace" : "create",
      target: { type: "file", id: targetId },
      dataSource: { kind: "file", id: targetId },
      outcome: "failed",
      before: beforeRevision ? { revision: beforeRevision } : undefined,
      durationMs: Date.now() - startedAt,
      error
    });
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
