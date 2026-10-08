import type http from "node:http";
import { definitionUsesNapcat, normalizeNapCatInstances, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";
import { getTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const PATH = "/api/agent/qq/diagnostics";
const PROBE_TIMEOUT_MS = 1500;
const MAX_PROBE_BYTES = 4096;

type Instance = ReturnType<typeof normalizeNapCatInstances>[number];
type Authority = { provider: string; sessionId: string };
type Status = { napcatInstances?: Record<string, { connected?: unknown; activeConnections?: unknown; lastConnectedAt?: unknown }> };
export type AgentQqDiagnosticsContext = {
  /** Exact Route lookup only; never scan other Routes for a matching instance. */
  route: (routeId: string) => GatewayDefinition | undefined;
  approvedBinding: (nodeId: string, agentId: string) => Authority | null;
  isAgentEnabled: (nodeId: string, agentId: string) => boolean;
  readStatus: (definition: GatewayDefinition) => Status;
  routeRunning: (routeId: string) => boolean;
  routeStartedAt: (routeId: string) => string | undefined;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  probe?: typeof fetch;
};

function authorized(source: TrustedLanAgentSource, definition: GatewayDefinition, context: AgentQqDiagnosticsContext): boolean {
  const binding = context.approvedBinding(source.nodeId, source.agentId);
  const provider = binding?.provider === "codex-desktop" ? "codex" : binding?.provider;
  const primary = resolvePrimaryAgentTarget(definition);
  return context.isAgentEnabled(source.nodeId, source.agentId)
    && provider === source.provider && Boolean(binding?.sessionId) && binding?.sessionId === source.sessionId
    && primary?.provider === source.provider && primary.binding?.instanceId === source.nodeId
    && primary.binding.agentId === source.agentId;
}

function localOneBotUrl(instance: Instance): string | undefined {
  try {
    const url = new URL(instance.httpUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

async function oneBotGet(origin: string, token: string | undefined, probe: typeof fetch): Promise<Record<string, unknown> | null> {
  const response = await probe(`${origin}/get_status`, {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_PROBE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROBE_BYTES) return null;
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    return result.status === "ok" && result.retcode === 0 && result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data as Record<string, unknown> : null;
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Strictly read-only: authorize current principal, exact Route and one instance before any status read or network probe. */
export async function handleAgentQqDiagnostics(
  request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, context: AgentQqDiagnosticsContext
): Promise<boolean> {
  if (requestUrl.pathname !== PATH || request.method !== "GET") return false;
  response.setHeader("cache-control", "no-store");
  const deny = (status: number, errorCode: string): true => {
    context.jsonResponse(response, status, { code: -1, errorCode });
    return true;
  };
  const source = getTrustedLanAgentSource(request);
  if (!source) return deny(403, "QQ_DIAGNOSTICS_TRUSTED_SOURCE_REQUIRED");
  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return deny(400, "QQ_DIAGNOSTICS_BODY_NOT_ALLOWED");
  const fields = [...requestUrl.searchParams.entries()];
  if (fields.length !== 1 || fields[0]?.[0] !== "routeId" || !fields[0][1] || fields[0][1].length > 256) return deny(400, "QQ_DIAGNOSTICS_ROUTE_REQUIRED");
  const routeId = fields[0][1];
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled === false || !authorized(source, definition, context)) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
  if (!definitionUsesNapcat(definition)) return deny(409, "QQ_DIAGNOSTICS_NAPCAT_DISABLED");
  // Do not let the normalizer silently choose the first entry of a legacy multi-instance Route.
  if (!Array.isArray(definition.napcatInstances) || definition.napcatInstances.length !== 1
    || definition.napcatInstances[0]?.enabled === false) return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS");
  let instances: ReturnType<typeof normalizeNapCatInstances>;
  try { instances = normalizeNapCatInstances(definition); }
  catch { return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS"); }
  if (instances.length !== 1 || instances[0]?.enabled === false) return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS");
  const instance = instances[0]!;
  const origin = localOneBotUrl(instance);
  if (!origin) return deny(409, "QQ_DIAGNOSTICS_ENDPOINT_UNSAFE");
  if (!context.routeRunning(routeId)) return deny(503, "QQ_DIAGNOSTICS_ROUTE_NOT_RUNNING");

  // Recheck authority at the point of the read; a revoked/rebound principal may not probe.
  if (!authorized(source, definition, context)) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
  try {
    const status = context.readStatus(definition).napcatInstances?.[instance.id];
    const startedAt = Date.parse(context.routeStartedAt(routeId) || "");
    const connectedAt = Date.parse(typeof status?.lastConnectedAt === "string" ? status.lastConnectedAt : "");
    const wsConnected = status?.connected === true && typeof status.activeConnections === "number"
      && status.activeConnections > 0 && Number.isFinite(startedAt) && Number.isFinite(connectedAt)
      && connectedAt >= startedAt;
    const probe = context.probe ?? fetch;
    const oneBot = await oneBotGet(origin, instance.accessToken, probe);
    // Authorization and Route binding can change while awaiting the probe.
    const current = context.route(routeId);
    const configured = current?.napcatInstances;
    if (!current || !authorized(source, current, context)
      || !context.routeRunning(routeId) || current.enabled === false || !definitionUsesNapcat(current)
      || !Array.isArray(configured) || configured.length !== 1 || configured[0]?.enabled === false
      || configured[0]?.id !== definition.napcatInstances?.[0]?.id
      || configured[0]?.httpUrl !== definition.napcatInstances?.[0]?.httpUrl
      || configured[0]?.accessToken !== definition.napcatInstances?.[0]?.accessToken) {
      return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
    }
    // Do not query identity or expose user_id/nickname: get_status alone reports online/good.
    context.jsonResponse(response, 200, {
      code: 0, data: { routeId, instanceId: instance.id, wsConnected,
        oneBot: { reachable: oneBot !== null, online: oneBot?.online === true, good: oneBot?.good === true } }
    });
  } catch {
    return deny(503, "QQ_DIAGNOSTICS_PROBE_UNAVAILABLE");
  }
  return true;
}
