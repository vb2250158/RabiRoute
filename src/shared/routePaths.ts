import path from "node:path";
import { sanitizeConfigName, sanitizeRoleId } from "./routeIdentity.js";

export type ResolvedRolePaths = {
  roleId: string;
  roleDir: string;
  rolePath: string;
  dataDir: string;
};

function assertChildPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes configured root: ${target}`);
  }
}

export function routeFolderPath(routeRoot: string, configName: unknown): string {
  const safeConfigName = sanitizeConfigName(configName);
  if (!safeConfigName) throw new Error("Missing route folder name");
  const root = path.resolve(routeRoot);
  const target = path.resolve(root, safeConfigName);
  assertChildPath(root, target);
  return target;
}

export function adapterConfigPath(routeRoot: string, configName: unknown): string {
  return path.join(routeFolderPath(routeRoot, configName), "adapterConfig.json");
}

export function roleFolderPath(rolesRoot: string, roleId: unknown): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) throw new Error("Missing role folder name");
  const root = path.resolve(rolesRoot);
  const target = path.resolve(root, safeRoleId);
  assertChildPath(root, target);
  return target;
}

export function personaConfigPath(rolesRoot: string, roleId: unknown): string {
  return path.join(roleFolderPath(rolesRoot, roleId), "personaConfig.json");
}

export function roleMessageConfigPath(rolesRoot: string, roleId: unknown): string {
  return path.join(roleFolderPath(rolesRoot, roleId), "roleMessageConfig.json");
}

export function routesConfigPath(rolesRoot: string, roleId: unknown): string {
  return path.join(roleFolderPath(rolesRoot, roleId), "routes.json");
}

export function normalizePersonaFile(value: unknown, fallback = "persona.md"): string {
  const trimmed = (value == null ? "" : String(value).trim()) || fallback;
  if (path.isAbsolute(trimmed)) return fallback;
  const normalized = path.normalize(trimmed).replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || segments.includes("..")) {
    return fallback;
  }
  return normalized;
}

export function roleFilePath(rolesRoot: string, roleId: unknown, roleFile: unknown = "persona.md"): string {
  const roleDir = roleFolderPath(rolesRoot, roleId);
  const target = path.resolve(roleDir, normalizePersonaFile(roleFile));
  assertChildPath(roleDir, target);
  return target;
}

export function resolveRolePaths(input: {
  agentRoleId?: unknown;
  agentRoleFile?: unknown;
  rolesDir: string;
  dataDir?: string;
  fallbackRoleId?: unknown;
  fallbackAgentRoleFile?: unknown;
  fallbackDataDir: string;
}): ResolvedRolePaths {
  const roleId = sanitizeRoleId(input.agentRoleId) || sanitizeRoleId(input.fallbackRoleId);
  const roleDir = roleId ? roleFolderPath(input.rolesDir, roleId) : "";
  const rolePath = roleDir
    ? roleFilePath(input.rolesDir, roleId, input.agentRoleFile || input.fallbackAgentRoleFile || "persona.md")
    : "";
  return {
    roleId,
    roleDir,
    rolePath,
    dataDir: roleDir || input.dataDir || input.fallbackDataDir
  };
}
