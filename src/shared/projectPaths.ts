import path from "node:path";

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isOutsideRelativePath(value: string): boolean {
  return value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value);
}

function pathPartsWithoutRoot(value: string): string[] {
  const normalized = slashPath(path.resolve(value));
  const root = slashPath(path.parse(normalized).root);
  const withoutRoot = root && normalized.toLowerCase().startsWith(root.toLowerCase())
    ? normalized.slice(root.length)
    : normalized;
  return withoutRoot.split("/").filter(Boolean);
}

function sameParts(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((part, index) => part.toLowerCase() === right[index].toLowerCase());
}

function rebaseProjectLikeAbsolutePath(value: string, projectRoot: string): string | null {
  const rootParts = pathPartsWithoutRoot(projectRoot);
  const valueParts = pathPartsWithoutRoot(value);
  if (rootParts.length === 0 || valueParts.length === 0) return null;

  if (rootParts.length > valueParts.length && sameParts(valueParts, rootParts.slice(0, valueParts.length))) {
    return Array.from({ length: rootParts.length - valueParts.length }, () => "..").join("/");
  }

  if (valueParts.length < rootParts.length) return null;

  const candidateRoot = valueParts.slice(0, rootParts.length);
  if (!sameParts(candidateRoot, rootParts)) return null;

  return valueParts.slice(rootParts.length).join("/") || ".";
}

export function toProjectRelativePath(value: unknown, projectRoot = process.cwd()): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const compact = slashPath(trimmed).replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") return undefined;

  if (!path.isAbsolute(trimmed)) {
    return slashPath(trimmed);
  }

  const relative = path.relative(projectRoot, trimmed);
  if (!isOutsideRelativePath(relative)) {
    return slashPath(relative) || ".";
  }

  return rebaseProjectLikeAbsolutePath(trimmed, projectRoot) ?? slashPath(trimmed);
}

export function resolveProjectPath(value: unknown, projectRoot = process.cwd()): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const relativeOrAbsolute = toProjectRelativePath(value, projectRoot);
  if (!relativeOrAbsolute) return undefined;
  if (trimmed && path.isAbsolute(trimmed)) {
    const relative = path.relative(projectRoot, trimmed);
    if (isOutsideRelativePath(relative) && !rebaseProjectLikeAbsolutePath(trimmed, projectRoot)) {
      return trimmed;
    }
  }
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(projectRoot, relativeOrAbsolute);
}
