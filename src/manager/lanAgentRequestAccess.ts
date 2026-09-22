import type { IncomingMessage } from "node:http";
import { isLanAgentCredentialToken, type LanAgentAuthority } from "./lanAgentAuthority.js";
import { authorizeAgentApiOperation } from "./agentApiPolicy.js";

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
  const ownContext = `/api/lan-agent/instances/${encodeURIComponent(identity.nodeId)}/agents/${encodeURIComponent(agentHeader)}/context`;
  const resourceRead = target.startsWith("/api/lan-agent/resources/read?")
    && [...url.searchParams.keys()].length === 1 && url.searchParams.has("id")
    && !/[\\\\\u0000-\u001f]/.test(url.searchParams.get("id") ?? "");
  const bootstrapRead = request.method === "GET" && (["/meta", "/api/lan-agent/capabilities", "/api/lan-agent/resources"].includes(target) || resourceRead);
  const hook = request.method === "POST" && target === ownContext;
  if (!bootstrapRead && !hook && !authorizeAgentApiOperation(request.method ?? "GET", target).allowed) {
    return { kind: "denied", status: 403, error: "LAN_AGENT_OPERATION_NOT_ALLOWED" };
  }
  return { kind: "agent", nodeId: identity.nodeId, agentId: agentHeader };
}
