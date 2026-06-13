export type RouteRuntimeParts = {
  roleId: string;
  configName: string;
};

export type RouteIdentityInput = {
  id?: unknown;
  agentRoleId?: unknown;
  configName?: unknown;
  fallbackRoleId?: unknown;
  fallbackConfigName?: unknown;
};

export type RouteIdentity = RouteRuntimeParts & {
  runtimeId: string;
};

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function sanitizeConfigName(value: unknown): string {
  return text(value)
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export function sanitizeRoleId(raw: unknown): string {
  const value = text(raw);
  return /^[\p{L}\p{N}_-]+$/u.test(value) ? value : "";
}

export function routeRuntimeId(_roleId: unknown, configName: unknown): string {
  return sanitizeConfigName(configName) || "default";
}

export function routeRuntimeParts(id: unknown): RouteRuntimeParts {
  const runtimeId = text(id);
  const [roleId, ...rest] = runtimeId.split("__");
  if (rest.length === 0) {
    return {
      roleId: "",
      configName: sanitizeConfigName(runtimeId) || "default"
    };
  }

  return {
    roleId: sanitizeRoleId(roleId),
    configName: sanitizeConfigName(rest.join("__")) || "default"
  };
}

export function resolveRouteIdentity(input: RouteIdentityInput): RouteIdentity {
  const parts = routeRuntimeParts(input.id);
  const hasRuntimeId = Boolean(text(input.id));
  const roleId = sanitizeRoleId(input.agentRoleId) || parts.roleId || sanitizeRoleId(input.fallbackRoleId);
  const configName = sanitizeConfigName(input.configName)
    || (hasRuntimeId ? parts.configName : "")
    || sanitizeConfigName(input.fallbackConfigName)
    || "default";
  return {
    roleId,
    configName,
    runtimeId: routeRuntimeId(roleId, configName)
  };
}
