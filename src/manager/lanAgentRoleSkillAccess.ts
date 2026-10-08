import type { RouteAgentTargetsDefinition } from "../shared/routeAgentTargets.js";
import type { LanAgentRequestAccess } from "./lanAgentRequestAccess.js";
import { parseRoleKnowledgeResourceRoute, parseRoleSkillDownloadRoute } from "./roleKnowledgeRoute.js";

export type LanAgentRoleSkillAccess =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string };

/** Scope this guard to the existing list/detail GET routes, including their public alias. */
export function authorizeLanAgentRoleSkillRequest<Definition extends RouteAgentTargetsDefinition>(
  access: LanAgentRequestAccess,
  method: string | undefined,
  pathname: string,
  definitions: readonly Definition[],
  roleIdForDefinition: (definition: Definition) => string
): LanAgentRoleSkillAccess {
  if (access.kind === "denied") return { allowed: false, status: access.status, error: access.error };
  if (method !== "GET") return { allowed: true };
  let download: ReturnType<typeof parseRoleSkillDownloadRoute>;
  try { download = parseRoleSkillDownloadRoute(pathname); }
  catch { return { allowed: false, status: 403, error: "INVALID_SKILL_DOWNLOAD_PATH" }; }
  if (download) return authorizeLanAgentRoleSkillRead(access, download.roleId, definitions, roleIdForDefinition);
  const route = parseRoleKnowledgeResourceRoute(pathname);
  if (route?.resource !== "skills") return { allowed: true };
  return authorizeLanAgentRoleSkillRead(access, route.roleId, definitions, roleIdForDefinition);
}

/**
 * Authenticated connections can read persona skills without another Route binding.
 * Role and skill existence, safe paths and archive bounds belong to the read handlers.
 */
export function authorizeLanAgentRoleSkillRead<Definition extends RouteAgentTargetsDefinition>(
  access: LanAgentRequestAccess,
  roleId: string,
  _definitions: readonly Definition[],
  _roleIdForDefinition: (definition: Definition) => string
): LanAgentRoleSkillAccess {
  if (access.kind === "denied") return { allowed: false, status: access.status, error: access.error };
  if (access.kind === "unrelated") return { allowed: true };
  const denied = { allowed: false, status: 403, error: "LAN_AGENT_PERSONA_NOT_CONFIGURED" } as const;
  if (!roleId || !access.nodeId || !access.agentId) return denied;
  return { allowed: true };
}
