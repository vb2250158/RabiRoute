import fs from "node:fs";
import path from "node:path";

export function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Identifies a Windows network path without touching the filesystem. Manager
 * lifecycle code uses this before any synchronous watch/stat call so a stalled
 * SMB redirector can never pin the control-plane event loop.
 */
export function isUncPath(value: string): boolean {
  const windowsPath = String(value || "").trim().replace(/\//g, "\\");
  return /^\\\\\?\\UNC\\/i.test(windowsPath)
    || /^\\\\(?![?.]\\)/.test(windowsPath);
}

function windowsDriveDesignator(value: string): string | undefined {
  const windowsPath = String(value || "").trim().replace(/\//g, "\\");
  const match = windowsPath.match(/^\\\\\?\\([a-z]):(?:\\|$)/i)
    ?? windowsPath.match(/^([a-z]):(?:\\|$)/i);
  return match ? `${match[1].toUpperCase()}:` : undefined;
}

/**
 * Conservatively keeps filesystem lifecycle work off the Manager event loop.
 * A drive-letter path is only trusted when it is on the configured Windows
 * system drive; mapped and otherwise unproven drives use an isolated worker.
 */
export function requiresWorkerFilesystemAccess(
  value: string,
  systemDrive = process.env.SystemDrive ?? ""
): boolean {
  if (isUncPath(value)) return true;
  const drive = windowsDriveDesignator(value);
  if (!drive) return false;
  const trustedDrive = windowsDriveDesignator(systemDrive);
  return !trustedDrive || drive !== trustedDrive;
}

export function normalizePathForComparison(value: string): string {
  let comparable = value;
  if (process.platform === "win32") {
    const windowsPath = value.replace(/\//g, "\\");
    comparable = /^\\\\\?\\UNC\\/i.test(windowsPath)
      ? `\\\\${windowsPath.slice(8)}`
      : /^\\\\\?\\/i.test(windowsPath)
        ? windowsPath.slice(4)
        : windowsPath;
  }
  const resolved = path.resolve(comparable);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathWithinRoot(root: string, target: string, allowRoot = true): boolean {
  const normalizedRoot = normalizePathForComparison(root);
  const normalizedTarget = normalizePathForComparison(target);
  if (normalizedTarget === normalizedRoot) return allowRoot;
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function assertPathWithinRoot(root: string, target: string, options: {
  allowRoot?: boolean;
  label?: string;
} = {}): string {
  const resolved = path.resolve(target);
  if (!isPathWithinRoot(root, resolved, options.allowRoot ?? true)) {
    throw new Error(`${options.label || "Path"} escapes configured root: ${resolved}`);
  }
  return resolved;
}

export function resolveRelativePathWithinRoot(root: string, reference: unknown, options: {
  allowRoot?: boolean;
  label?: string;
} = {}): string {
  const value = typeof reference === "string" ? reference.trim() : "";
  if (!value) throw new Error(`${options.label || "Path"} is required.`);
  if (path.isAbsolute(value)) throw new Error(`${options.label || "Path"} must be relative to its configured root.`);
  return assertPathWithinRoot(root, path.resolve(root, value), options);
}

export function assertExistingPathWithinRoots(target: string, roots: string[], label = "Path"): string {
  const resolvedTarget = path.resolve(target);
  const realTarget = fs.realpathSync.native(resolvedTarget);
  const allowed = roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync.native(resolvedRoot) : resolvedRoot;
    return isPathWithinRoot(realRoot, realTarget, true);
  });
  if (!allowed) throw new Error(`${label} escapes every configured root: ${resolvedTarget}`);
  return realTarget;
}
