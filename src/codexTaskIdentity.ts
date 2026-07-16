import fs from "node:fs";
import path from "node:path";
export { isCodexTaskId } from "./shared/codexTaskId.js";

const resolvedWorkspaceCache = new Map<string, string>();

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
  const shouldResolveAlias = !windowsPath || (process.platform === "win32" && /^[a-z]:[\\/]/i.test(withoutNamespace));
  if (shouldResolveAlias) {
    try {
      resolved = fs.realpathSync.native(resolved);
      aliasResolved = true;
    } catch {
      // Stale workspaces still need deterministic comparison and diagnostics.
    }
  }

  const normalized = withoutWindowsNamespace(resolved)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const result = process.platform === "win32" || windowsPath
    ? normalized.toLocaleLowerCase()
    : normalized;
  if (aliasResolved) resolvedWorkspaceCache.set(cacheKey, result);
  return result;
}

export function sameCodexWorkspace(left: string | undefined, right: string | undefined): boolean {
  const leftKey = canonicalCodexWorkspacePath(left);
  const rightKey = canonicalCodexWorkspacePath(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}
