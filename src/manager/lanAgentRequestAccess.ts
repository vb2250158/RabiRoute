import type { IncomingMessage } from "node:http";
import { isLanAgentCredentialToken, type LanAgentAuthority } from "./lanAgentAuthority.js";
import { validateAgentApiRequestTarget } from "./agentApiPolicy.js";

export type LanAgentRequestAccess =
  | { kind: "unrelated" }
  | { kind: "denied"; status: 401 | 403; error: string }
  | { kind: "agent"; nodeId: string; agentId: string };

/** Node-only connection diagnostics, never a business authorization grant. */
export function isLanNodeMetadataRequest(request: IncomingMessage, authority: LanAgentAuthority): boolean {
  const token = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "" : "";
  return request.method === "GET" && request.url === "/meta" && Boolean(authority.authenticate(token));
}

/** Run before local/admin exemptions and independently authorized legacy routes. */
export function evaluateLanAgentRequest(request: IncomingMessage, authority: LanAgentAuthority, enabled: boolean): LanAgentRequestAccess {
  const bearer = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "" : "";
  const agentHeader = request.headers["x-rabiroute-agent-id"];
  const legacyHeader = request.headers["x-rabiroute-webgui-token"];
  const target = request.url ?? "/";
  const url = new URL(target, "http://manager.invalid");
  const candidate = isLanAgentCredentialToken(bearer) || agentHeader !== undefined
    || (typeof legacyHeader === "string" && isLanAgentCredentialToken(legacyHeader))
    || [...url.searchParams.values()].some(isLanAgentCredentialToken);
  if (!candidate) return { kind: "unrelated" };
  if (enabled && request.method === "GET" && target.startsWith("/api/lan-agent/releases/") && !/[\\\\%]/.test(target) && !target.split("/").includes("..")
    && agentHeader === undefined && legacyHeader === undefined && !url.search
    && authority.authenticate(bearer)) return { kind: "unrelated" };
  if (enabled && request.method === "GET" && ["/api/lan-agent/self", "/meta"].includes(target)
    && agentHeader === undefined && legacyHeader === undefined && authority.authenticate(bearer)) return { kind: "unrelated" };
  if (!enabled || typeof agentHeader !== "string" || !agentHeader || !isLanAgentCredentialToken(bearer)
    || legacyHeader !== undefined || url.searchParams.has("webgui_token") || url.searchParams.has("token")) {
    return { kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" };
  }
  const identity = authority.authorize(bearer, agentHeader);
  if (!identity) return { kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" };
  if (!validateAgentApiRequestTarget(request.method ?? "GET", target).allowed) {
    return { kind: "denied", status: 403, error: "LAN_AGENT_INVALID_REQUEST_TARGET" };
  }
  // Generic hooks have no authenticated remote owner mapping. Keep the own-Agent
  // context path rather than allowing callers to claim another session's identity.
  if (url.pathname.startsWith("/api/codex-hook/")) {
    return { kind: "denied", status: 403, error: "LAN_AGENT_SOURCE_NOT_SUPPORTED" };
  }
  // One authenticated connection uses the provided APIs; the catalog is discovery,
  // not a second permission grant. Handlers still validate their request contracts.
  return { kind: "agent", nodeId: identity.nodeId, agentId: agentHeader };
}
