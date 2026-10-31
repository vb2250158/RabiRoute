import type { IncomingMessage } from "node:http";
import { isLanAgentCredentialToken, type LanAgentAuthority, type LanAgentConnectionLease } from "./lanAgentAuthority.js";
import { validateAgentApiRequestTarget } from "./agentApiPolicy.js";

import { isAgentAdapterType, type AgentAdapterType } from "../shared/agentAdapterCapabilities.js";

type Source = Readonly<{ agentId: string; provider: AgentAdapterType; sessionId: string }>;
type AdmittedConnection = LanAgentConnectionLease & { agentId: string; source?: Source };
type AdmissionPolicy = Readonly<{ enabled: boolean; incarnation: string }>;
type RequestPrincipal = { authority: LanAgentAuthority; token: string; lease: AdmittedConnection;
  admission: AdmissionPolicy; readAdmission: () => AdmissionPolicy };
// Only successful credential-first ingress can issue a request principal.
const principals = new WeakMap<IncomingMessage, RequestPrincipal>();
const admittedRequests = new WeakSet<IncomingMessage>();

export function hasTrustedLanAgentPrincipal(request: IncomingMessage): boolean { return principals.has(request); }
export function assertTrustedLanAgentPrincipal(request: IncomingMessage): AdmittedConnection | undefined {
  const principal = principals.get(request);
  if (!principal) {
    if (admittedRequests.has(request) || request.headers?.["x-rabiroute-agent-id"] !== undefined || request.headers?.["x-rabiroute-agent-type"] !== undefined || request.headers?.["x-rabiroute-session-id"] !== undefined) throw new Error("Remote Agent request principal is unavailable.");
    return undefined;
  }
  const policy = principal.readAdmission();
  if (!policy.enabled || policy.incarnation !== principal.admission.incarnation) {
    throw new Error("Remote Agent admission was disabled or replaced.");
  }
  principal.authority.assertConnectionLease(principal.token, principal.lease);
  return principal.lease;
}

export type LanAgentRequestAccess =
  | { kind: "unrelated" }
  | { kind: "denied"; status: 400 | 401 | 403; error: string }
  | { kind: "agent"; nodeId: string; agentId: string };

/** Node-only connection diagnostics, never a business authorization grant. */
export function isLanNodeMetadataRequest(request: IncomingMessage, authority: LanAgentAuthority): boolean {
  const token = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "" : "";
  return request.method === "GET" && request.url === "/meta" && Boolean(authority.authenticate(token));
}

/** Run before local/admin exemptions and independently authorized legacy routes. */
export function evaluateLanAgentRequest(request: IncomingMessage, authority: LanAgentAuthority, enabled: boolean,
  readAdmission: () => AdmissionPolicy = () => ({ enabled, incarnation: "static-test-policy" })): LanAgentRequestAccess {
  const captured = principals.get(request);
  if (!captured && admittedRequests.has(request)) {
    return { kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" };
  }
  if (captured) {
    try { assertTrustedLanAgentPrincipal(request); }
    catch {
      principals.delete(request);
      return { kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" };
    }
    // Nested route evaluation must never replace the original request's admission fence.
    const currentBearer = typeof request.headers.authorization === "string"
      ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "" : "";
    if (currentBearer !== captured.token || request.headers["x-rabiroute-agent-type"] !== captured.lease.source?.provider || request.headers["x-rabiroute-session-id"] !== captured.lease.source?.sessionId) {
      principals.delete(request);
      return { kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" };
    }
    readAdmission = captured.readAdmission;
  }
  const admission = captured?.admission ?? readAdmission();
  enabled = enabled && admission.enabled;
  const bearer = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "" : "";
  const agentHeader = request.headers["x-rabiroute-agent-id"];
  const provider = request.headers["x-rabiroute-agent-type"];
  const sessionId = request.headers["x-rabiroute-session-id"];
  const legacyHeader = request.headers["x-rabiroute-webgui-token"];
  const target = request.url ?? "/";
  const url = new URL(target, "http://manager.invalid");
  const candidate = isLanAgentCredentialToken(bearer) || agentHeader !== undefined || provider !== undefined || sessionId !== undefined
    || (typeof legacyHeader === "string" && isLanAgentCredentialToken(legacyHeader))
    || [...url.searchParams.values()].some(isLanAgentCredentialToken);
  if (!candidate) return { kind: "unrelated" };
  if (!enabled || !isLanAgentCredentialToken(bearer) || legacyHeader !== undefined
    || url.searchParams.has("webgui_token") || url.searchParams.has("token")) {
    return { kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" };
  }
  if ((provider !== undefined || sessionId !== undefined)
    && (!isAgentAdapterType(provider) || typeof sessionId !== "string" || !sessionId || sessionId !== sessionId.trim()
      || sessionId.length > 4096 || /[\x00-\x1f\x7f]/.test(sessionId))) {
    return { kind: "denied", status: 400, error: "LAN_AGENT_EXPLICIT_SOURCE_REQUIRED" };
  }
  const node = captured?.lease ?? authority.acquireConnectionLease(bearer);
  if (!node) return { kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" };
  const source: Source | undefined = isAgentAdapterType(provider) && typeof sessionId === "string"
    ? Object.freeze({ agentId: provider, provider, sessionId }) : undefined;
  const identity: AdmittedConnection = captured?.lease ?? Object.freeze({ ...node, agentId: source?.agentId ?? node.nodeId,
    ...(source ? { source } : {}) });
  if (!validateAgentApiRequestTarget(request.method ?? "GET", target).allowed) {
    return { kind: "denied", status: 403, error: "LAN_AGENT_INVALID_REQUEST_TARGET" };
  }
  // An enabled authenticated Agent uses the shared public route policy.
  // The catalog describes contracts, not a second remote-only permission grant.
  admittedRequests.add(request);
  principals.set(request, captured ?? { authority, token: bearer, lease: identity, admission, readAdmission });
  return { kind: "agent", nodeId: identity.nodeId, agentId: identity.agentId };
}
