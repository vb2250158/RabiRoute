import fs from "node:fs";
import path from "node:path";

export function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
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
