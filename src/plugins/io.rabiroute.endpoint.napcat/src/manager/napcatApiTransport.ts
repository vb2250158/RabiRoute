import type { IncomingMessage } from "node:http";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "@rabiroute/host-api/manager/lanAgentBodyAuthority";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { definitionUsesNapcat, type GatewayDefinition, type NapCatInstanceDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { boundedBytes, qqRead, QqReadError } from "./qqMessageMedia.js";

export class NapcatApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export type NapcatApiTransportContext = {
  route(routeId: string): GatewayDefinition | undefined;
  local(request: IncomingMessage): boolean;
  assertCurrent?(): void;
  transport?: typeof fetch;
};

export type NapcatApiSelection = Readonly<{
  routeId: string;
  instanceId: string;
  botUserId: string;
  httpUrl: string;
  accessToken: string;
  assertCurrent(): void;
}>;

function authenticated(request: IncomingMessage, context: NapcatApiTransportContext): boolean {
  try {
    if (assertTrustedLanAgentPrincipal(request) || hasAuthenticatedConnectionRequest(request)) return true;
    if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"]
      || request.headers["x-rabiroute-peer-proxy"] || getTrustedLanAgentSource(request) || hasLanAgentBodyGuard(request)) return false;
    return context.local(request);
  } catch { return false; }
}

/** Shared existing authority guard; management bootstrap does not imply OneBot account readiness. */
export function assertNapcatApiRequestAuthority(context: NapcatApiTransportContext, request: IncomingMessage, signal?: AbortSignal): void {
  context.assertCurrent?.();
  signal?.throwIfAborted();
  if (!authenticated(request, context)) throw new NapcatApiError(403, "QQ_API_AUTH_REQUIRED");
}

/** Capture the original Route, instance and configured QQ account before any provider call. */
export function selectNapcatApiInstance(context: NapcatApiTransportContext, request: IncomingMessage,
  routeId: string, instanceId: string, signal?: AbortSignal): NapcatApiSelection {
  const authorize = () => assertNapcatApiRequestAuthority(context, request, signal);
  authorize();
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled !== true || !definitionUsesNapcat(definition)) throw new NapcatApiError(409, "QQ_API_ROUTE_UNAVAILABLE");
  const instances = definition.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
  if (instances.length !== 1) throw new NapcatApiError(409, "QQ_API_INSTANCE_UNAVAILABLE");
  const instance = instances[0]!;
  const botUserId = String(instance.botUserId ?? "");
  if (!/^[1-9]\d{0,15}$/.test(botUserId)) throw new NapcatApiError(409, "QQ_API_CONFIGURED_ACCOUNT_REQUIRED");
  let url: URL;
  try { url = new URL(instance.httpUrl); }
  catch { throw new NapcatApiError(409, "QQ_API_ENDPOINT_UNSAFE"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new NapcatApiError(409, "QQ_API_ENDPOINT_UNSAFE");
  }
  const snapshot = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "", botUserId };
  const currentInstance = (): NapCatInstanceDefinition | undefined => {
    const current = context.route(routeId);
    if (current !== definition || current.id !== routeId || current.enabled !== true || !definitionUsesNapcat(current)) return;
    const matches = current.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const assertCurrent = () => {
    authorize();
    const current = currentInstance();
    if (!current || current.httpUrl !== snapshot.httpUrl || (current.accessToken ?? "") !== snapshot.accessToken
      || String(current.botUserId ?? "") !== botUserId) throw new NapcatApiError(409, "QQ_API_BINDING_CHANGED");
  };
  return Object.freeze({ routeId, instanceId, botUserId, httpUrl: url.origin, accessToken: snapshot.accessToken, assertCurrent });
}

/** Shared by the fixed OneBot and WebUI transports; the current selected identity is never caller-supplied. */
export async function verifyNapcatApiIdentity(context: NapcatApiTransportContext, selection: NapcatApiSelection, signal: AbortSignal): Promise<Record<string, unknown>> {
  selection.assertCurrent();
  const identity = await qqRead(selection, "get_login_info", {}, signal, context.transport);
  selection.assertCurrent();
  if (String(identity.user_id ?? "") !== selection.botUserId) throw new NapcatApiError(409, "QQ_API_ACCOUNT_MISMATCH");
  return identity;
}

/** The caller supplies a registered static action. Provider errors never include raw bodies or URLs. */
export async function callNapcatApi(context: NapcatApiTransportContext, selection: NapcatApiSelection,
  action: string, parameters: unknown, registeredActions: ReadonlySet<string>, signal: AbortSignal): Promise<unknown> {
  if (!registeredActions.has(action) || !/^\.?[a-zA-Z_][a-zA-Z0-9_]*$/.test(action)) throw new NapcatApiError(404, "QQ_API_ACTION_NOT_REGISTERED");
  await verifyNapcatApiIdentity(context, selection, signal);
  const response = await (context.transport ?? fetch)(new URL(action, selection.httpUrl + "/"), {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", ...(selection.accessToken ? { authorization: `Bearer ${selection.accessToken}` } : {}) },
    body: JSON.stringify(parameters)
  });
  if (!response.ok) throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
  const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
  selection.assertCurrent();
  let envelope: { status?: unknown; retcode?: unknown; data?: unknown };
  try { envelope = JSON.parse(bytes.toString("utf8")); }
  catch { throw new NapcatApiError(503, "QQ_API_UPSTREAM_RESPONSE_INVALID"); }
  if (envelope?.status !== "ok" || envelope.retcode !== 0) throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
  return envelope.data;
}

export function napcatApiFailure(error: unknown): { status: number; body: { code: -1; errorCode: string } } {
  if (error instanceof NapcatApiError || error instanceof QqReadError) return { status: error.status, body: { code: -1, errorCode: error.code } };
  return { status: 503, body: { code: -1, errorCode: "QQ_API_UPSTREAM_UNAVAILABLE" } };
}
