import path from "node:path";
import { parseGatewayMessageHistoryLine, type GatewayMessageHistoryIdentity } from "../gatewayMessageHistory.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { localPersonaMessageDirectories, routeOwnsLocalPersona } from "./localPersonaOwner.js";

const directoryKey = (directory: string): string => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);

type MessageHistoryScope = {
  definition: GatewayDefinition;
  rootDir: string; routeDataDir: string;
  roleIdForDefinition(definition: GatewayDefinition): string;
  roleDirectory(roleId: string): string;
};
type MessageHistoryEvent = Readonly<{ roleId: string; gatewayId: string }>;

function ownedEvents(input: MessageHistoryScope): ReadonlyArray<MessageHistoryEvent> {
  const directories = new Set(localPersonaMessageDirectories(input.rootDir, input.definition, input.routeDataDir).map(directoryKey));
  const definitions = [input.definition, ...(input.definition.routeProfiles ?? []).filter(profile => Boolean(profile.agentRoleId)).map(profile => ({
    ...input.definition, ...profile, agentRoleDeviceId: profile.agentRoleDeviceId ?? input.definition.agentRoleDeviceId
  }))];
  const roles = new Set<string>();
  for (const definition of definitions) {
    if (!routeOwnsLocalPersona(definition)) continue;
    const roleId = input.roleIdForDefinition(definition);
    if (roleId && directories.has(directoryKey(input.roleDirectory(roleId)))) roles.add(roleId);
  }
  return [...roles].map(roleId => Object.freeze({ roleId, gatewayId: input.definition.id }));
}

/** The current child and current Route, rather than event-supplied role names, own invalidation scope. */
export function gatewayMessageHistoryEvents(input: MessageHistoryScope & {
  line: string; expected: GatewayMessageHistoryIdentity; currentChild: boolean;
}): ReadonlyArray<MessageHistoryEvent> {
  if (!input.currentChild || input.definition.id !== input.expected.gatewayId || !parseGatewayMessageHistoryLine(input.line, input.expected)) return [];
  return ownedEvents(input);
}

/** Manager-local outbound writes use the same existing owner scope as Gateway hints. */
export function localMessageHistoryEvents(input: MessageHistoryScope & { directory: string }): ReadonlyArray<MessageHistoryEvent> {
  const directory = directoryKey(input.directory);
  if (!localPersonaMessageDirectories(input.rootDir, input.definition, input.routeDataDir).some(value => directoryKey(value) === directory)) return [];
  return ownedEvents(input);
}
