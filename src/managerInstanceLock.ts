import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ManagerInstanceOwner = {
  pid: number;
  ownerId: string;
  startedAt: string;
  projectRoot: string;
};

export type ManagerInstanceLockOptions = {
  rootDir: string;
  pid?: number;
  ownerId?: string;
  isProcessAlive?: (pid: number) => boolean;
};

export type ManagerInstanceLock = {
  lockPath: string;
  owner: ManagerInstanceOwner;
  release(): void;
};

export class ManagerInstanceAlreadyRunningError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly owner: ManagerInstanceOwner
  ) {
    super(`RabiRoute Manager is already running (pid=${owner.pid}, root=${owner.projectRoot}).`);
    this.name = "ManagerInstanceAlreadyRunningError";
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): ManagerInstanceOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ManagerInstanceOwner>;
    const pid = Number(parsed.pid);
    const ownerId = String(parsed.ownerId || "").trim();
    if (!Number.isInteger(pid) || pid <= 0 || !ownerId) return null;
    return {
      pid,
      ownerId,
      startedAt: String(parsed.startedAt || ""),
      projectRoot: String(parsed.projectRoot || "")
    };
  } catch {
    return null;
  }
}

function writeExclusive(lockPath: string, owner: ManagerInstanceOwner): void {
  const handle = fs.openSync(lockPath, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function moveStaleLockAside(lockPath: string, ownerId: string): boolean {
  const stalePath = `${lockPath}.stale-${ownerId}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    fs.unlinkSync(stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

export function acquireManagerInstanceLock(options: ManagerInstanceLockOptions): ManagerInstanceLock {
  const rootDir = path.resolve(options.rootDir);
  const runtimeDir = path.join(rootDir, "data", ".runtime");
  const lockPath = path.join(runtimeDir, "manager-instance.lock");
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const owner: ManagerInstanceOwner = {
    pid,
    ownerId: options.ownerId ?? randomUUID(),
    startedAt: new Date().toISOString(),
    projectRoot: rootDir
  };
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeExclusive(lockPath, owner);
      let released = false;
      return {
        lockPath,
        owner,
        release() {
          if (released) return;
          released = true;
          const current = readOwner(lockPath);
          if (current?.ownerId !== owner.ownerId) return;
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readOwner(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new ManagerInstanceAlreadyRunningError(lockPath, existing);
      }
      moveStaleLockAside(lockPath, owner.ownerId);
    }
  }

  const existing = readOwner(lockPath);
  if (existing) throw new ManagerInstanceAlreadyRunningError(lockPath, existing);
  throw new Error(`RabiRoute Manager instance lock could not be acquired: ${lockPath}`);
}
