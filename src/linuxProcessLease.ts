import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export type LinuxProcessLeaseOptions = Readonly<{
  namespace: string;
  owner: Readonly<Record<string, unknown>>;
}>;

export type LinuxProcessLease = Readonly<{
  leasePath: string;
  ownerPath: string;
  owner: Readonly<Record<string, unknown>>;
  release(): Promise<void>;
}>;

export class LinuxProcessLeaseAlreadyHeldError extends Error {
  constructor(readonly leasePath: string, readonly owner: Record<string, unknown> | null) {
    super("The Linux process lease is already held.");
    this.name = "LinuxProcessLeaseAlreadyHeldError";
  }
}

function requirePrivateFile(stat: fs.Stats, uid: number): void {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    throw new Error("Linux process lease file must be a private, singly linked regular file owned by the current user.");
  }
}

function readOwner(ownerPath: string, uid: number): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    requirePrivateFile(stat, uid);
    if (stat.size > 16_384) return null;
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * flock(2) belongs to an open-file description, not to the short-lived utility.
 * The child inherits descriptor 3 from this process; after flock exits, our FD
 * retains the kernel lease until release or process death. Never unlink the
 * stable lock inode, and never use diagnostic metadata as ownership evidence.
 */
export function linuxProcessLeasePaths(namespace: string): Readonly<{ directory: string; leasePath: string; ownerPath: string }> {
  if (process.platform !== "linux" || !process.getuid) throw new Error("Linux process leases require Linux.");
  if (!namespace || namespace.length > 4096 || /[\u0000-\u001f\u007f]/.test(namespace)) {
    throw new Error("Linux process lease namespace is invalid.");
  }
  const directory = path.join("/tmp", `rabiroute-process-leases-${process.getuid()}`);
  const key = createHash("sha256").update(namespace).digest("hex");
  return Object.freeze({ directory, leasePath: path.join(directory, `${key}.lock`), ownerPath: path.join(directory, `${key}.owner.json`) });
}

export async function acquireLinuxProcessLease(options: LinuxProcessLeaseOptions): Promise<LinuxProcessLease> {
  const { directory, leasePath, ownerPath } = linuxProcessLeasePaths(options.namespace);
  const ownerBytes = Buffer.from(`${JSON.stringify(options.owner)}\n`, "utf8");
  if (ownerBytes.length > 16_384) throw new Error("Linux process lease owner metadata is too large.");
  const uid = process.getuid!();
  // A fixed local root keeps the per-user identity independent of cwd, state
  // roots and inherited TMPDIR/XDG settings. Directory access is user-only.
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("Linux process lease directory must be private and owned by the current user, without symlinks.");
  }
  const fd = fs.openSync(leasePath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    requirePrivateFile(fs.fstatSync(fd), uid);
    const executable = ["/usr/bin/flock", "/bin/flock"].find(candidate => fs.existsSync(candidate));
    if (!executable) throw new Error("Linux RabiRoute requires util-linux flock. Install the util-linux package first.");
    const result = spawnSync(executable, ["--exclusive", "--nonblock", "--conflict-exit-code", "17", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 5_000, maxBuffer: 4_096
    });
    if (result.error || result.signal) throw new Error("Linux process lease acquisition could not be confirmed.", { cause: result.error });
    if (result.status === 17) throw new LinuxProcessLeaseAlreadyHeldError(leasePath, readOwner(ownerPath, uid));
    if (result.status !== 0) throw new Error(`Linux process lease acquisition failed (flock exit ${result.status ?? "unknown"}).`);
    const temporary = `${ownerPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, ownerBytes, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, ownerPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  let released = false;
  return Object.freeze({
    leasePath, ownerPath, owner: options.owner,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try { fs.unlinkSync(ownerPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { fs.closeSync(fd); }
    }
  });
}
