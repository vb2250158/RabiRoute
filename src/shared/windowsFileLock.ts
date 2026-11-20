import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const windowsEpoch = 116_444_736_000_000_000n;
const queryProcess = 0x1000; // PROCESS_QUERY_LIMITED_INFORMATION
const synchronize = 0x00100000;
const waitSignaled = 0;
const waitTimedOut = 0x102;
const stillActive = 259;
const deleteAccess = 0x00010000;
const readAccess = 0x80000000;
const shareRead = 1;
const openExisting = 3;
const openReparsePoint = 0x00200000;
const fileBasicInfo = 0;
const fileDispositionInfo = 4;
const directoryOrReparsePoint = 0x10 | 0x400;
const maxRecordBytes = 4_096;

function loadWindowsApi() {
  const koffi = require("koffi") as typeof import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const bind = (name: string, result: string, args: string[]) => kernel.func("__stdcall", name, result, args);
  return {
    openProcess: bind("OpenProcess", "intptr_t", ["uint32", "int", "uint32"]),
    processTimes: bind("GetProcessTimes", "int", ["intptr_t", "void *", "void *", "void *", "void *"]),
    wait: bind("WaitForSingleObject", "uint32", ["intptr_t", "uint32"]),
    exitCode: bind("GetExitCodeProcess", "int", ["intptr_t", "void *"]),
    openFile: bind("CreateFileW", "intptr_t", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *"]),
    getInfo: bind("GetFileInformationByHandleEx", "int", ["intptr_t", "int", "void *", "uint32"]),
    readFile: bind("ReadFile", "int", ["intptr_t", "void *", "uint32", "void *", "void *"]),
    setInfo: bind("SetFileInformationByHandle", "int", ["intptr_t", "int", "void *", "uint32"]),
    close: bind("CloseHandle", "int", ["intptr_t"]),
    lastError: bind("GetLastError", "uint32", [])
  };
}

let windowsApi: ReturnType<typeof loadWindowsApi> | null | undefined;

function getWindowsApi() {
  if (windowsApi === undefined) {
    try {
      windowsApi = loadWindowsApi();
    } catch {
      // Ordinary exclusive creation still works without the native addon.
      // Stale Windows locks require the guarded native recovery path.
      windowsApi = null;
    }
  }
  return windowsApi;
}

let currentProcessStart: bigint | undefined;

/** A null result means the PID is absent or exited. Undefined means its identity is unknown. */
export function readWindowsLockProcessStart(pid: number): bigint | null | undefined {
  if (pid === process.pid && currentProcessStart !== undefined) return currentProcessStart;
  const api = getWindowsApi();
  if (!api) return undefined;
  let handle = api.openProcess(queryProcess | synchronize, 0, pid);
  const canWait = Boolean(handle);
  if (!handle) {
    const code = api.lastError();
    if (code !== 5) return code === 87 ? null : undefined; // ERROR_INVALID_PARAMETER
    // Some process ACLs permit reading identity without synchronization access.
    handle = api.openProcess(queryProcess, 0, pid);
    if (!handle) return api.lastError() === 87 ? null : undefined;
  }
  try {
    if (canWait) {
      // A terminated process stays queryable while another handle references it.
      // A zero-duration wait tests liveness even if its exit code is 259.
      const state = api.wait(handle, 0);
      if (state === waitSignaled) return null;
      if (state !== waitTimedOut) return undefined;
    } else {
      const exitCode = Buffer.alloc(4);
      if (!api.exitCode(handle, exitCode)) return undefined;
      if (exitCode.readUInt32LE() !== stillActive) return null;
    }
    const times = Buffer.alloc(32);
    if (!api.processTimes(handle, times, times.subarray(8), times.subarray(16), times.subarray(24))) return undefined;
    const started = times.readBigUInt64LE() || undefined;
    if (pid === process.pid) currentProcessStart = started;
    return started;
  } finally {
    api.close(handle);
  }
}

export function fileTimeToUnixMs(time: bigint): number {
  return Number((time - windowsEpoch) / 10_000n);
}

function handleFailure(operation: string, code: number): boolean {
  if (code === 2 || code === 3) return true; // File or parent directory disappeared.
  if (code === 5 || code === 32 || code === 33 || code === 303) return false; // Denied, shared, locked or delete pending.
  throw new Error(`${operation} failed while reclaiming a Windows file lock (${code})`);
}

export function reclaimWindowsFileLock(
  lockPath: string,
  shouldReclaim: (contents: string, mtimeMs: number) => boolean
): boolean {
  const api = getWindowsApi();
  if (!api) return false;
  // Exclude concurrent writes, renames and deletes until the final check and
  // disposition complete. Read and delete the same handle, including over SMB.
  const handle = api.openFile(path.toNamespacedPath(lockPath), readAccess + deleteAccess, shareRead,
    null, openExisting, openReparsePoint, null);
  if (handle === -1 || handle === -1n) return handleFailure("CreateFileW", api.lastError());
  try {
    const info = Buffer.alloc(40); // FILE_BASIC_INFO, including alignment padding.
    if (!api.getInfo(handle, fileBasicInfo, info, info.length)) {
      return handleFailure("GetFileInformationByHandleEx", api.lastError());
    }
    if (info.readUInt32LE(32) & directoryOrReparsePoint) return false;
    const contents = Buffer.alloc(maxRecordBytes + 1);
    const bytesRead = Buffer.alloc(4);
    if (!api.readFile(handle, contents, contents.length, bytesRead, null)) {
      return handleFailure("ReadFile", api.lastError());
    }
    const length = bytesRead.readUInt32LE();
    if (length > maxRecordBytes || !shouldReclaim(contents.toString("utf8", 0, length),
      fileTimeToUnixMs(info.readBigUInt64LE(16)))) return false;
    if (!api.setInfo(handle, fileDispositionInfo, Buffer.from([1]), 1)) {
      return handleFailure("SetFileInformationByHandle", api.lastError());
    }
    return true;
  } finally {
    api.close(handle);
  }
}
