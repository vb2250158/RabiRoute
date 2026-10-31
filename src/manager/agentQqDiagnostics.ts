import { ReadSettingsError } from "../shared/readSettingsError.js";
import type http from "node:http";
import { qqReadSettings } from "../shared/qqReadSettings.js";
import { definitionUsesNapcat, normalizeNapCatInstances, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

const PATH = "/api/agent/qq/diagnostics";
const METHOD = "GET";
const queryContract = { type: "object", required: ["routeId"], additionalProperties: false,
  properties: { routeId: { type: "string", minLength: 1, maxLength: 256 } } } as const;


type Instance = ReturnType<typeof normalizeNapCatInstances>[number];
type Status = { napcatInstances?: Record<string, { connected?: unknown; activeConnections?: unknown; lastConnectedAt?: unknown }> };
export type AgentQqDiagnosticsContext = {
  /** Exact Route lookup only; never scan other Routes for a matching instance. */
  route: (routeId: string) => GatewayDefinition | undefined;
  readStatus: (definition: GatewayDefinition) => Status;
  routeRunning: (routeId: string) => boolean;
  routeStartedAt: (routeId: string) => string | undefined;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  probe?: typeof fetch;
};

function configuredOneBotUrl(instance: Instance): string | undefined {
  try {
    const url = new URL(instance.httpUrl);
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

async function oneBotGet(origin: string, token: string | undefined, probe: typeof fetch): Promise<Record<string, unknown> | null> {
  const MAX_PROBE_BYTES = qqReadSettings.jsonBytes;
  const response = await probe(`${origin}/get_status`, {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(qqReadSettings.readTimeoutMs),
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const quotaError = () => new Error(`RABIROUTE_QQ_JSON_MAX_BYTES=${MAX_PROBE_BYTES} exceeded; increase the Manager environment setting or set 0 to remove the application quota.`);
  if (Number(response.headers.get("content-length")) > MAX_PROBE_BYTES) { await response.body?.cancel(); throw quotaError(); }
  if (!response.ok) {
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
      if (size > MAX_PROBE_BYTES) throw quotaError();
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
  if (requestUrl.pathname !== PATH || request.method !== METHOD) return false;
  response.setHeader("cache-control", "no-store");
  const deny = (status: number, errorCode: string, message?: string): true => {
    context.jsonResponse(response, status, { code: -1, errorCode, ...(message ? { message } : {}) });
    return true;
  };
  let principal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
  try { principal = assertTrustedLanAgentPrincipal(request); }
  catch { return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED"); }
  const authorized = () => {
    try {
      // Keep the original ingress lease; revocation must never select local fallback.
      if (assertTrustedLanAgentPrincipal(request) !== principal) return false;
      if (principal) return true;
      if (getTrustedLanAgentSource(request) || hasLanAgentBodyGuard(request)) return false;
      if (hasAuthenticatedConnectionRequest(request)) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request)
        && localModelSettingsRequestAllowed(request);
    } catch { return false; }
  };
  if (!authorized()) return deny(403, "QQ_DIAGNOSTICS_TRUSTED_SOURCE_REQUIRED");
  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return deny(400, "QQ_DIAGNOSTICS_BODY_NOT_ALLOWED");
  const fields = [...requestUrl.searchParams.entries()];
  if (fields.length !== 1 || fields[0]?.[0] !== "routeId" || !fields[0][1] || fields[0][1].length > queryContract.properties.routeId.maxLength) return deny(400, "QQ_DIAGNOSTICS_ROUTE_REQUIRED");
  const routeId = fields[0][1];
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled === false || !authorized()) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
  if (!definitionUsesNapcat(definition)) return deny(409, "QQ_DIAGNOSTICS_NAPCAT_DISABLED");
  // Do not let the normalizer silently choose the first entry of a legacy multi-instance Route.
  if (!Array.isArray(definition.napcatInstances) || definition.napcatInstances.length !== 1
    || definition.napcatInstances[0]?.enabled === false) return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS");
  let instances: ReturnType<typeof normalizeNapCatInstances>;
  try { instances = normalizeNapCatInstances(definition); }
  catch { return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS"); }
  if (instances.length !== 1 || instances[0]?.enabled === false) return deny(409, "QQ_DIAGNOSTICS_INSTANCE_AMBIGUOUS");
  const instance = instances[0]!;
  const origin = configuredOneBotUrl(instance);
  const configuredInstance = { ...definition.napcatInstances[0] };
  if (!origin) return deny(409, "QQ_DIAGNOSTICS_ENDPOINT_UNSAFE");
  if (!context.routeRunning(routeId)) return deny(503, "QQ_DIAGNOSTICS_ROUTE_NOT_RUNNING");
  const currentRouteAllowed = () => {
    if (!authorized()) return false;
    const current = context.route(routeId);
    const configured = current?.napcatInstances;
    return Boolean(current && current.id === routeId && context.routeRunning(routeId)
      && current.enabled !== false && definitionUsesNapcat(current)
      && Array.isArray(configured) && configured.length === 1 && configured[0]?.enabled !== false
      && configured[0]?.id === configuredInstance.id
      && configured[0]?.httpUrl === configuredInstance.httpUrl
      && configured[0]?.accessToken === configuredInstance.accessToken);
  };

  // Recheck authority at the point of the read; a revoked/rebound principal may not probe.
  if (!authorized()) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
  try {
    const status = context.readStatus(definition).napcatInstances?.[instance.id];
    const startedAt = Date.parse(context.routeStartedAt(routeId) || "");
    const connectedAt = Date.parse(typeof status?.lastConnectedAt === "string" ? status.lastConnectedAt : "");
    const wsConnected = status?.connected === true && typeof status.activeConnections === "number"
      && status.activeConnections > 0 && Number.isFinite(startedAt) && Number.isFinite(connectedAt)
      && connectedAt >= startedAt;
    const probe = context.probe ?? fetch;
    if (!currentRouteAllowed()) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
    const oneBot = await oneBotGet(origin, instance.accessToken, probe);
    // The original principal and exact Route configuration may change while awaiting the probe.
    if (!currentRouteAllowed()) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
    // Do not query identity or expose user_id/nickname: get_status alone reports online/good.
    context.jsonResponse(response, 200, {
      code: 0, data: { routeId, instanceId: instance.id, wsConnected,
        oneBot: { reachable: oneBot !== null, online: oneBot?.online === true, good: oneBot?.good === true } }
    });
  } catch (error) {
    if (!authorized()) return deny(403, "QQ_DIAGNOSTICS_NOT_AUTHORIZED");
    if (error instanceof ReadSettingsError) return deny(503, error.code, error.message);
    if (error instanceof Error && error.message.startsWith("RABIROUTE_QQ_JSON_MAX_BYTES=")) return deny(503, "QQ_DIAGNOSTICS_RESPONSE_TOO_LARGE", error.message);
    if (error instanceof Error && error.name === "TimeoutError") return deny(503, "QQ_DIAGNOSTICS_PROBE_TIMEOUT", `QQ status probe exceeded RABIROUTE_QQ_READ_TIMEOUT_MS=${qqReadSettings.readTimeoutMs} ms.`);
    return deny(503, "QQ_DIAGNOSTICS_PROBE_UNAVAILABLE");
  }
  return true;
}

export function createAgentQqDiagnosticsOperation(context: AgentQqDiagnosticsContext): ApiOperationDefinition {
  const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"],
    properties: { code: { const: -1 }, errorCode: { type: "string" }, message: { type: "string" } }, additionalProperties: false } } as const;
  return {
    contract: {
      operationId: "agent.qq.diagnostics", contractVersion: "1.0.0", method: METHOD, pathTemplate: PATH,
      aliases: [`agent:GET:${PATH}`],
      description: "Read the selected QQ instance connection state without exposing account identity or credentials.",
      exposure: "public", transport: "http",
      request: { path: { type: "object", properties: {}, additionalProperties: false }, query: queryContract,
        headers: { type: "object", properties: { "content-length": false, "transfer-encoding": false }, additionalProperties: true }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
        properties: { code: { const: 0 }, data: { type: "object", required: ["routeId", "instanceId", "wsConnected", "oneBot"], additionalProperties: false,
          properties: { routeId: { type: "string" }, instanceId: { type: "string" }, wsConnected: { type: "boolean" },
            oneBot: { type: "object", required: ["reachable", "online", "good"], additionalProperties: false,
              properties: { reachable: { type: "boolean" }, online: { type: "boolean" }, good: { type: "boolean" } } } } } } } },
        "400": error, "403": error, "409": error, "503": error },
      effects: { mode: "read", description: "Reads the selected Route status and performs one bounded get_status probe; does not send messages or query account identity." },
      recovery: { strategy: "repeatable-read", description: "Refresh the current contract after a version mismatch; do not change the selected Route to bypass an explicit disable." },
      validators: [{ id: "agent.qq.diagnostics.source", description: "The existing ingress principal and selected Route/instance are revalidated before and after the upstream read." },
        { id: "agent.qq.diagnostics.endpoint", description: "The owner uses the configured enabled HTTP(S) OneBot instance without a loopback-only restriction." }]
    },
    async handler(input) {
      let result: ApiOperationResult | undefined;
      await handleAgentQqDiagnostics(input.request, input.url, input.response, { ...context,
        jsonResponse: (_response, status, body) => { result = { status, body, headers: { "cache-control": "no-store" } }; } });
      if (!result) throw new Error("QQ diagnostics did not produce a response.");
      return result;
    }
  };
}
