import type { RouteAgentTargetsDefinition } from "../shared/routeAgentTargets.js";
import type { LanAgentRequestAccess } from "./lanAgentRequestAccess.js";
import { parseRoleSkillDownloadRoute } from "./roleKnowledgeRoute.js";

export type LanAgentRoleSkillAccess =
  | { allowed: true }
  | { allowed: false; status: 400 | 401 | 403; error: string };

/**
 * Authentication belongs to credential-first ingress, including revocation.
 * Enabled Agents share local public Skill access; Route targets are delivery
 * configuration, not another authorization store. Keep download path checks.
 */
export function authorizeLanAgentRoleSkillRequest(
  access: LanAgentRequestAccess,
  method: string | undefined,
  pathname: string
): LanAgentRoleSkillAccess {
  if (access.kind === "denied") return { allowed: false, status: access.status, error: access.error };
  if (method !== "GET") return { allowed: true };
  try { parseRoleSkillDownloadRoute(pathname); }
  catch { return { allowed: false, status: 403, error: "INVALID_SKILL_DOWNLOAD_PATH" }; }
  return { allowed: true };
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
