import { normalizeRouteAgentTargets, type RouteAgentTargetsDefinition } from "../shared/routeAgentTargets.js";
import type { LanAgentRequestAccess } from "./lanAgentRequestAccess.js";
import { parseRoleKnowledgeResourceRoute } from "./roleKnowledgeRoute.js";

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
  const route = parseRoleKnowledgeResourceRoute(pathname);
  if (route?.resource !== "skills") return { allowed: true };
  return authorizeLanAgentRoleSkillRead(access, route.roleId, definitions, roleIdForDefinition);
}

/**
 * Additional object authorization for role Skill reads, after ordinary request authentication.
 * Definitions and roleIdForDefinition must come from the current Manager route catalog.
 * No per-Skill grants or independent binding cache: an exact node + Agent target grants
 * access to the configured persona's effective Skill directory. Unrelated requests still
 * require their existing local/management authentication; this does not grant that access.
 */
export function authorizeLanAgentRoleSkillRead<Definition extends RouteAgentTargetsDefinition>(
  access: LanAgentRequestAccess,
  roleId: string,
  definitions: readonly Definition[],
  roleIdForDefinition: (definition: Definition) => string
): LanAgentRoleSkillAccess {
  if (access.kind === "denied") return { allowed: false, status: access.status, error: access.error };
  if (access.kind === "unrelated") return { allowed: true };
  const denied = { allowed: false, status: 403, error: "LAN_AGENT_PERSONA_NOT_CONFIGURED" } as const;
  if (!roleId || !access.nodeId || !access.agentId) return denied;
  for (const definition of definitions) {
    if (roleIdForDefinition(definition) !== roleId) continue;
    const configured = normalizeRouteAgentTargets(definition).remoteAgentTargets.some(target =>
      target.instanceId === access.nodeId && target.agentId === access.agentId
    );
    if (configured) return { allowed: true };
  }
  return denied;
}
