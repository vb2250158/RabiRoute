import fs, { constants } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
type Mode = "shared" | "exclusive";
type Release = () => void | Promise<void>;

function windowsLock() {
  const koffi = require("koffi") as typeof import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const bind = (name: string, result: string, args: string[]) => kernel.func("__stdcall", name, result, args);
  const open = bind("CreateFileW", "intptr_t", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *"]);
  const info = bind("GetFileInformationByHandleEx", "int", ["intptr_t", "int", "void *", "uint32"]);
  const lock = bind("LockFileEx", "int", ["intptr_t", "uint32", "uint32", "uint32", "uint32", "void *"]);
  const unlock = bind("UnlockFileEx", "int", ["intptr_t", "uint32", "uint32", "uint32", "void *"]);
  const close = bind("CloseHandle", "int", ["intptr_t"]);
  const lastError = bind("GetLastError", "uint32", []);
  const overlappedBytes = koffi.sizeof("void *") === 8 ? 32 : 20;
  return (file: string, mode: Mode): Release | undefined => {
    // All participants share read and write access to the handle, while its
    // byte lock coordinates access. Excluding FILE_SHARE_DELETE keeps its identity stable.
    const handle = open(path.toNamespacedPath(file), 0xc0000000, 3, null, 4, 0x00200000, null);
    if (handle === -1 || handle === -1n) throw new Error(`CreateFileW failed (${lastError()})`);
    let acquired = false;
    try {
      const basicInfo = Buffer.alloc(40);
      if (!info(handle, 0, basicInfo, basicInfo.length)) throw new Error(`GetFileInformationByHandleEx failed (${lastError()})`);
      if (basicInfo.readUInt32LE(32) & 0x410) throw new Error("Role lock must be a regular file");
      const overlapped = Buffer.alloc(overlappedBytes);
      acquired = Boolean(lock(handle, mode === "shared" ? 1 : 3, 0, 1, 0, overlapped));
      if (!acquired) {
        const code = lastError();
        if (code === 33) return undefined; // ERROR_LOCK_VIOLATION
        throw new Error(`LockFileEx failed (${code})`);
      }
      return () => {
        try {
          if (!unlock(handle, 0, 1, 0, overlapped)) throw new Error(`UnlockFileEx failed (${lastError()})`);
        } finally { close(handle); }
      };
    } finally {
      if (!acquired) close(handle);
    }
  };
}

function posixLock() {
  const koffi = require("koffi") as typeof import("koffi");
  const libc = koffi.load(null);
  const flock = libc.func("int flock(int fd, int operation)");
  return async (file: string, mode: Mode): Promise<Release | undefined> => {
    const handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let acquired = false;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Role lock must be a regular file");
      acquired = flock(handle.fd, (mode === "shared" ? 1 : 2) | 4) === 0; // LOCK_SH/LOCK_EX | LOCK_NB
      if (!acquired) {
        const code = koffi.errno();
        if (code === os.constants.errno.EWOULDBLOCK || code === os.constants.errno.EAGAIN) return undefined;
        throw new Error(`flock failed (${code})`);
      }
      return () => handle.close();
    } finally {
      if (!acquired) await handle.close();
    }
  };
}

let acquire: ReturnType<typeof windowsLock> | ReturnType<typeof posixLock> | undefined;

/** Open an OS-owned lock on a stable file. Keep the file in place after release. */
export async function tryRoleFileLock(file: string, mode: Mode): Promise<Release | undefined> {
  acquire ??= process.platform === "win32" ? windowsLock() : posixLock();
  return acquire(file, mode);
}
