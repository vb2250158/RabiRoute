import path from "node:path";
import { roleFolderPath } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

type PersonaOwner = { agentRoleDeviceId?: string; agentRoleId?: string };
type PersonaRoute = PersonaOwner & {
  agentRoleId?: string;
  rolesDir?: string;
  dataDir?: string;
  routeProfiles?: Array<PersonaOwner & { agentRoleId?: string; rolesDir?: string; dataDir?: string }>;
};

export function routeOwnsLocalPersona(definition: PersonaOwner): boolean {
  return !definition.agentRoleDeviceId;
}

export function assertLocalPersonaOwner(definition: PersonaOwner, operation: string): void {
  if (!routeOwnsLocalPersona(definition)) {
    throw new Error(`REMOTE_PERSONA_OWNER_REQUIRED: ${operation} must use the explicit remote persona owner.`);
  }
}

/** Gateway diagnostics may read Route audit files, never a remote reference's local namesake. */
export function localPersonaMessageDirectories(rootDir: string, definition: PersonaRoute, routeDataDir: string): string[] {
  const directories = new Set<string>([routeDataDir]);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleId = sanitizeRoleId(definition.agentRoleId);
  if (roleId && routeOwnsLocalPersona(definition)) directories.add(roleFolderPath(rolesDir, roleId));
  for (const profile of definition.routeProfiles ?? []) {
    if (profile.dataDir) directories.add(path.resolve(rootDir, profile.dataDir));
    const profileRole = sanitizeRoleId(profile.agentRoleId);
    if (profileRole && routeOwnsLocalPersona({ agentRoleDeviceId: profile.agentRoleDeviceId ?? definition.agentRoleDeviceId })) {
      directories.add(roleFolderPath(path.resolve(rootDir, profile.rolesDir ?? definition.rolesDir ?? path.join("data", "roles")), profileRole));
    }
  }
  return [...directories];
}

/** A local plan may only choose a Route owned by that local persona, even with an explicit ID. */
export function localPersonaRuntimeForDelivery<R extends { definition: PersonaOwner & { id: string } }>(
  runtimes: Iterable<R>, roleId: string, gatewayId: string, roleIdForDefinition: (definition: R["definition"]) => string
): R {
  const candidates = [...runtimes];
  if (gatewayId) {
    const runtime = candidates.find(item => item.definition.id === gatewayId);
    if (!runtime) throw new Error(`Gateway not found: ${gatewayId}`);
    assertLocalPersonaOwner(runtime.definition, "Local persona delivery");
    if (roleIdForDefinition(runtime.definition) !== roleId) throw new Error(`Gateway ${gatewayId} is not bound to role ${roleId}.`);
    return runtime;
  }
  const matches = candidates.filter(runtime => routeOwnsLocalPersona(runtime.definition) && roleIdForDefinition(runtime.definition) === roleId);
  if (matches.length === 0) throw new Error(`No local gateway is bound to role ${roleId}.`);
  if (matches.length > 1) throw new Error(`Multiple gateways are bound to role ${roleId}; gatewayId is required.`);
  return matches[0]!;
}

/** A shared Agent Hook cannot silently pick a local persona when any bound Route has another owner. */
export function localPersonaRoleForHooks<D extends PersonaOwner>(definitions: readonly D[], roleIdForDefinition: (definition: D) => string): string {
  definitions.forEach(definition => assertLocalPersonaOwner(definition, "Persona Hooks"));
  const roles = [...new Set(definitions.map(roleIdForDefinition))];
  if (roles.length !== 1) throw new Error("Bind this instance Agent to one local persona before using its Hooks.");
  return roles[0]!;
}

/** An old Hook binding cannot turn a remote or mixed-owner task into a local persona. */
export function localPersonaRoleForAgentTask<D extends PersonaOwner>(
  definitions: readonly D[], roleIdForDefinition: (definition: D) => string, boundRoleId?: string
): string | undefined {
  if (definitions.some(definition => !routeOwnsLocalPersona(definition))) return undefined;
  const roles = new Set(definitions.map(roleIdForDefinition).filter(Boolean));
  if (boundRoleId) roles.add(boundRoleId);
  return roles.size === 1 ? [...roles][0] : undefined;
}
