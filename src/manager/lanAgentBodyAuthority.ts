import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";

export type TrustedLanAgentSource = { nodeId: string; agentId: string; provider?: AgentAdapterType; sessionId?: string; sessionName?: string; workspace?: string; authorizationIncarnation?: string };
const sources = new WeakMap<IncomingMessage, TrustedLanAgentSource>();
export function setTrustedLanAgentSource(request: IncomingMessage, source: TrustedLanAgentSource): void { sources.set(request, Object.freeze({ ...source })); }
/** Record the admitted node even when its request carries no task headers. */
export function captureTrustedLanAgentSource(request: IncomingMessage, policyIncarnation: string): void {
  const connection = assertTrustedLanAgentPrincipal(request);
  if (!connection) return;
  const binding = connection.source;
  setTrustedLanAgentSource(request, { nodeId: connection.nodeId, agentId: connection.agentId,
    ...(binding ? { provider: binding.provider, sessionId: binding.sessionId, sessionName: binding.agentId } : {}),
    authorizationIncarnation: createHash("sha256").update(JSON.stringify([
      connection.incarnation, policyIncarnation
    ])).digest("hex") });
}
export function getTrustedLanAgentSource(request: IncomingMessage): TrustedLanAgentSource | undefined {
  assertTrustedLanAgentPrincipal(request);
  return sources.get(request);
}
const guards = new WeakMap<IncomingMessage, (body: unknown) => void>();
export function registerLanAgentBodyGuard(request: IncomingMessage, guard: (body: unknown) => void): void { guards.set(request, guard); }
export function hasLanAgentBodyGuard(request: IncomingMessage): boolean { return guards.has(request); }
export function validateLanAgentRequestBody(request: IncomingMessage, body: unknown): void {
  assertTrustedLanAgentPrincipal(request);
  const guard = guards.get(request);

  guard?.(body);
}

/** Compatibility hook for callers; connected invocations have no per-source authority check.
 * Each operation's body schema owns its target and payload contract. */
export function assertLanAgentBodyAuthority(_target: string, _body: unknown,
  _agent: { provider?: string; sessionId?: string } | undefined): void {}
