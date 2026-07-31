import fs from "node:fs";
import path from "node:path";

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function resolveRealDirectory(value, label = "Remote Agent cwd") {
  const resolved = path.resolve(String(value || ""));
  let realPath;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be resolved: ${resolved}`, { cause: error });
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (error) {
    throw new Error(`${label} cannot be inspected: ${realPath}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${realPath}`);
  }
  return realPath;
}

export function parseAllowedCwdRoots(raw, fallback) {
  let values = [];
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values = parsed;
      else throw new Error("expected a JSON array");
    } catch (error) {
      if (raw.trim().startsWith("[")) {
        throw new Error("REMOTE_AGENT_ALLOWED_CWDS must be a JSON array or a semicolon-delimited path list.", { cause: error });
      }
      values = raw.split(";");
    }
  }
  const uniqueRoots = new Map();
  for (const value of [fallback, ...values]) {
    const text = String(value || "").trim();
    if (!text) continue;
    const realPath = resolveRealDirectory(text, "Remote Agent allowed cwd root");
    uniqueRoots.set(comparablePath(realPath), realPath);
  }
  if (!uniqueRoots.size) {
    throw new Error("Remote Agent requires at least one allowed cwd root.");
  }
  return [...uniqueRoots.values()];
}

export function resolveTaskCwd(value, { defaultCwd, allowedCwdRoots }) {
  const realPath = resolveRealDirectory(value || defaultCwd, "Remote Agent task cwd");
  const comparable = comparablePath(realPath);
  const allowed = allowedCwdRoots.some((root) => {
    const comparableRoot = comparablePath(root);
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}${path.sep}`);
  });
  if (!allowed) {
    throw new Error(`Remote Agent cwd is outside REMOTE_AGENT_ALLOWED_CWDS: ${realPath}`);
  }
  return realPath;
}

export function resolveRealFileWithinRoots(value, allowedRoots, label = "Remote Agent result file") {
  const resolved = path.resolve(String(value || ""));
  let realPath;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be resolved: ${resolved}`, { cause: error });
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${realPath}`);
  const comparable = comparablePath(realPath);
  const allowed = allowedRoots.some((root) => {
    const comparableRoot = comparablePath(root);
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}${path.sep}`);
  });
  if (!allowed) throw new Error(`${label} is outside the current task cwd: ${realPath}`);
  return realPath;
}
