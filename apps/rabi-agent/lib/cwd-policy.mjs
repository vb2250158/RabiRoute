import fs from "node:fs";
import path from "node:path";

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function resolveRealDirectory(value, label = "Rabi Agent workspace") {
  const resolved = path.resolve(String(value || ""));
  let realPath;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be resolved: ${resolved}`, { cause: error });
  }
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${realPath}`);
  return realPath;
}

export function normalizeAllowedWorkspaces(values, fallback) {
  const rawValues = Array.isArray(values) ? values : [];
  const unique = new Map();
  for (const value of [fallback, ...rawValues]) {
    const text = String(value || "").trim();
    if (!text) continue;
    const realPath = resolveRealDirectory(text, "Rabi Agent allowed workspace");
    unique.set(comparablePath(realPath), realPath);
  }
  if (!unique.size) throw new Error("Rabi Agent requires at least one allowed workspace.");
  return [...unique.values()];
}

export function resolveTaskWorkspace(value, { defaultWorkspace, allowedWorkspaces }) {
  const realPath = resolveRealDirectory(value || defaultWorkspace, "Rabi Agent task workspace");
  const comparable = comparablePath(realPath);
  const allowed = allowedWorkspaces.some(root => {
    const comparableRoot = comparablePath(root);
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}${path.sep}`);
  });
  if (!allowed) throw new Error(`Rabi Agent task workspace is outside the declared allowed workspaces: ${realPath}`);
  return realPath;
}
