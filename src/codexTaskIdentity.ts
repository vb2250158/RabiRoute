import fs from "node:fs";
import path from "node:path";
export { isCodexTaskId } from "./shared/codexTaskId.js";

const resolvedWorkspaceCache = new Map<string, string>();
// Drives whose realpath failed or was slow (mapped SMB/NAS). realpathSync on them can block the
// Manager main thread for seconds per row, so they only get lexical keys until restart.
const slowWorkspaceDrives = new Set<string>();
const SLOW_REALPATH_MS = 250;
let workspaceRealpath: (value: string) => string = value => fs.realpathSync.native(value);

/** Test hook: replace the synchronous realpath and reset caches. */
export function setCodexWorkspaceRealpathForTest(realpath?: (value: string) => string): void {
  workspaceRealpath = realpath ?? (value => fs.realpathSync.native(value));
  resolvedWorkspaceCache.clear();
  slowWorkspaceDrives.clear();
}

function workspaceDrive(value: string): string {
  const drive = /^([a-z]):/i.exec(value);
  if (drive) return drive[1].toLowerCase() + ":";
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(value);
  if (unc) return `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`;
  return value.startsWith("/") ? "/" : "";
}

function withoutWindowsNamespace(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\/i.test(value)) return value.slice(4);
  return value;
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

/**
 * Resolve drive aliases when possible and normalize extended-length/UNC forms.
 * The result is only a comparison key; the original path remains the display
 * and persistence value.
 */
export function canonicalCodexWorkspacePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const withoutNamespace = withoutWindowsNamespace(trimmed);
  const windowsPath = isWindowsPath(withoutNamespace);
  const cacheKey = windowsPath || process.platform === "win32"
    ? withoutNamespace.toLocaleLowerCase()
    : withoutNamespace;
  const cached = resolvedWorkspaceCache.get(cacheKey);
  if (cached) return cached;

  let resolved = windowsPath && process.platform !== "win32"
    ? path.win32.normalize(withoutNamespace)
    : path.resolve(withoutNamespace);
  let aliasResolved = false;
  // UNC paths are never realpath'd (network IO on the main thread); drive paths only while their drive is fast.
  const drive = workspaceDrive(withoutNamespace);
  const shouldResolveAlias = (!windowsPath || (process.platform === "win32" && /^[a-z]:[\\/]/i.test(withoutNamespace)))
    && !slowWorkspaceDrives.has(drive);
  if (shouldResolveAlias) {
    const started = Date.now();
    try {
      resolved = workspaceRealpath(resolved);
      aliasResolved = true;
    } catch {
      // Stale workspaces still need deterministic comparison and diagnostics.
    }
    if (windowsPath && (!aliasResolved || Date.now() - started > SLOW_REALPATH_MS)) slowWorkspaceDrives.add(drive);
  }

  const normalized = withoutWindowsNamespace(resolved)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const result = process.platform === "win32" || windowsPath
    ? normalized.toLocaleLowerCase()
    : normalized;
  // Failures and slow drives are cached too, so a restartless retry never pays the network timeout again.
  resolvedWorkspaceCache.set(cacheKey, result);
  return result;
}

function lexicalWorkspaceKey(value: string): string {
  const withoutNamespace = withoutWindowsNamespace(value.trim());
  const windowsPath = isWindowsPath(withoutNamespace);
  const normalized = (windowsPath ? path.win32.normalize(withoutNamespace) : withoutNamespace).replace(/\\/g, "/").replace(/\/+$/, "");
  return windowsPath || process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

/**
 * Build a workspace filter for many rows. A cheap lexical drive/prefix check runs first; only rows on a drive
 * that could match an allowed workspace are canonicalized (and possibly realpath'd).
 */
export function createCodexWorkspaceMatcher(allowedWorkspaces: readonly string[] | undefined): (cwd: string | undefined) => boolean {
  const allowedRaw = (allowedWorkspaces ?? []).map(value => value?.trim()).filter((value): value is string => Boolean(value));
  if (allowedRaw.length === 0) return () => true;
  const allowed = new Set(allowedRaw.map(canonicalCodexWorkspacePath));
  const drives = new Set<string>();
  for (const value of [...allowedRaw.map(lexicalWorkspaceKey), ...allowed]) drives.add(workspaceDrive(value));
  return cwd => {
    const trimmed = cwd?.trim();
    if (!trimmed) return false;
    const lexical = lexicalWorkspaceKey(trimmed);
    if (allowed.has(lexical)) return true;
    if (!drives.has(workspaceDrive(lexical))) return false;
    return allowed.has(canonicalCodexWorkspacePath(trimmed));
  };
}

export function sameCodexWorkspace(left: string | undefined, right: string | undefined): boolean {
  const leftKey = canonicalCodexWorkspacePath(left);
  const rightKey = canonicalCodexWorkspacePath(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}
