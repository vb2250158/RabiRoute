import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export type ManagerInstanceOwner = {
  pid: number;
  ownerId: string;
  startedAt: string;
  projectRoot: string;
};

export type ManagerInstanceLockOptions = {
  rootDir: string;
  ownershipNamespace?: string;
  pid?: number;
  ownerId?: string;
};

export type ManagerInstanceLock = {
  lockPath: string;
  leaseAddress: string;
  owner: ManagerInstanceOwner;
  release(): Promise<void>;
};

export class ManagerInstanceAlreadyRunningError extends Error {
  constructor(public readonly lockPath: string, public readonly owner: ManagerInstanceOwner) {
    super(`RabiRoute Manager is already running (pid=${owner.pid}, root=${owner.projectRoot}).`);
    this.name = "ManagerInstanceAlreadyRunningError";
  }
}

export function readManagerInstanceOwner(lockPath: string): ManagerInstanceOwner | null {
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

function removeDiagnosticLock(lockPath: string, ownerId: string): void {
  const stalePath = `${lockPath}.stale-${ownerId}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  try {
    fs.unlinkSync(stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function windowsUserSid(): string | null {
  try {
    const executable = process.env.SystemRoot?.trim()
      ? path.join(process.env.SystemRoot.trim(), "System32", "whoami.exe")
      : "whoami.exe";
    const output = execFileSync(executable, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output.match(/,"(S-\d+(?:-\d+)+)"\s*$/i)?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

export function managerInstanceOwnershipNamespace(): string {
  if (process.platform === "win32") {
    const sid = windowsUserSid();
    if (sid) return `windows-sid:${sid}`;
    throw new Error("RabiRoute Manager cannot establish the current Windows SID ownership namespace.");
  }
  const user = os.userInfo();
  return `user:${user.uid}:${user.username}:${os.homedir()}`;
}

export function managerInstanceLeaseAddress(
  ownershipNamespace = managerInstanceOwnershipNamespace()
): string {
  const identity = createHash("sha256").update(ownershipNamespace).digest("hex").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\RabiRoute-Manager-${identity}`
    : path.join(os.tmpdir(), `rabiroute-manager-${identity}.sock`);
}

async function listenLease(server: net.Server, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onListening = (): void => { cleanup(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: address, exclusive: true });
  });
}

async function acquireOsLease(address: string, owner: ManagerInstanceOwner): Promise<net.Server> {
  const create = (): net.Server => {
    const server = net.createServer(socket => socket.end(`${JSON.stringify(owner)}\n`));
    server.unref();
    return server;
  };
  let server = create();
  try {
    await listenLease(server, address);
    return server;
  } catch (error) {
    try { server.close(); } catch { }
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" || code !== "EADDRINUSE") throw error;
    const stale = await new Promise<boolean>(resolve => {
      const socket = net.createConnection(address);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", probeError => {
        const probeCode = (probeError as NodeJS.ErrnoException).code;
        resolve(probeCode === "ECONNREFUSED" || probeCode === "ENOENT");
      });
    });
    if (!stale) throw error;
    try { fs.unlinkSync(address); } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    }
    server = create();
    await listenLease(server, address);
    return server;
  }
}

async function readOsLeaseOwner(address: string): Promise<ManagerInstanceOwner | null> {
  return await new Promise(resolve => {
    const socket = net.createConnection(address);
    const chunks: Buffer[] = [];
    let completed = false;
    const finish = (owner: ManagerInstanceOwner | null): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(owner);
    };
    const timeout = setTimeout(() => finish(null), 1_000);
    timeout.unref();
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ManagerInstanceOwner;
        finish(Number.isInteger(parsed.pid) && parsed.pid > 0 && String(parsed.ownerId || "").trim()
          ? parsed
          : null);
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
  });
}

async function closeLease(lease: net.Server): Promise<void> {
  if (!lease.listening) return;
  await new Promise<void>(resolve => lease.close(() => resolve()));
}

export async function acquireManagerInstanceLock(options: ManagerInstanceLockOptions): Promise<ManagerInstanceLock> {
  const rootDir = path.resolve(options.rootDir);
  const ownershipNamespace = options.ownershipNamespace ?? managerInstanceOwnershipNamespace();
  const receiptScope = createHash("sha256").update(ownershipNamespace).digest("hex").slice(0, 16);
  const runtimeDir = path.join(rootDir, "data", ".runtime", "manager", receiptScope);
  const lockPath = path.join(runtimeDir, "manager-instance.lock");
  const leaseAddress = managerInstanceLeaseAddress(ownershipNamespace);
  const owner: ManagerInstanceOwner = {
    pid: options.pid ?? process.pid,
    ownerId: options.ownerId ?? randomUUID(),
    startedAt: new Date().toISOString(),
    projectRoot: rootDir
  };
  fs.mkdirSync(runtimeDir, { recursive: true });

  let lease: net.Server;
  try {
    lease = await acquireOsLease(leaseAddress, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const existing = await readOsLeaseOwner(leaseAddress) ?? readManagerInstanceOwner(lockPath) ?? {
      pid: 0,
      ownerId: "os-lease-owner",
      startedAt: "",
      projectRoot: rootDir
    };
    throw new ManagerInstanceAlreadyRunningError(lockPath, existing);
  }

  try {
    removeDiagnosticLock(lockPath, owner.ownerId);
    writeExclusive(lockPath, owner);
  } catch (error) {
    await closeLease(lease);
    throw error;
  }

  let released = false;
  return {
    lockPath,
    leaseAddress,
    owner,
    async release() {
      if (released) return;
      released = true;
      await closeLease(lease);
      const current = readManagerInstanceOwner(lockPath);
      if (current?.ownerId === owner.ownerId) {
        try { fs.unlinkSync(lockPath); } catch { }
      }
      if (process.platform !== "win32") {
        try { fs.unlinkSync(leaseAddress); } catch { }
      }
    }
  };
}
