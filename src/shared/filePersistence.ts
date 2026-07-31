import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

export type AtomicWriteFileOptions = {
  maxRenameAttempts?: number;
  retryDelayMs?: number;
  renameSync?: (source: string, destination: string) => void;
};

export function withFileLockSync<T>(
  lockPath: string,
  action: () => T,
  options: FileLockOptions = {}
): T {
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 5_000));
  const staleMs = Math.max(timeoutMs, Math.floor(options.staleMs ?? 30_000));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      try {
        return action();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (process.platform !== "win32" || code !== "EPERM") throw error;
        try {
          fs.statSync(lockPath);
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs >= staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      Atomics.wait(lockWaitBuffer, 0, 0, 10);
    }
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
  const maxRenameAttempts = Math.max(1, Math.floor(options.maxRenameAttempts ?? 8));
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 25));
  const renameSync = options.renameSync ?? fs.renameSync;
  try {
    const descriptor = fs.openSync(temporary, "wx");
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
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
