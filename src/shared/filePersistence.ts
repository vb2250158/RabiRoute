import fs from "node:fs";
import path from "node:path";

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
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

export function atomicWriteFileSync(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
