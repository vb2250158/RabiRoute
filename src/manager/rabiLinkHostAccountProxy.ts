import { randomUUID } from "node:crypto";
import { apiRequestHeaderAllowed } from "../../packages/rabi-api-contract/request.mjs";
import { peerProxyRequestHeaders, tunnelHeaders } from "../peerTunnel/http.js";
import { TunnelDenied } from "../peerTunnel/security.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type { ApiHttpProxyInput } from "./apiOperationContract.js";
import { rabiLinkTransportAssertionPresent } from "./rabiLinkAgentDeviceConnection.js";

export type AccountProxyRelay = { url: string; token: string; accountId: string };
type HostResult = { statusCode?: number; headers?: Record<string, string>; data?: unknown; uncertain?: boolean;
  ok?: boolean; code?: string };
const BODY_LIMIT = 180 * 1024;
/** A Relay that cannot confirm a target answers `{ok:false, code}` without a status code. Forward that original
 * code and uncertainty instead of keeping a status table that has to guess every future failure. */
function unconfirmedFailure(result: HostResult) {
  if (result.ok !== false) return undefined;
  const code = typeof result.code === "string" && result.code ? result.code : "API_TRANSPORT_UNCONFIRMED";
  return { code, message: `远端 PC 未返回可用响应（${code}）。请确认目标电脑在线且 RabiRoute 正在运行。`, uncertain: result.uncertain === true };
}

async function requestBody(input: ApiHttpProxyInput) {
  if (["GET", "HEAD"].includes(input.request.method || "GET")) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input.request) {
    input.signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new Error("Account Relay request body is too large.");
    chunks.push(bytes);
  }
  return size ? Buffer.concat(chunks).toString("base64") : undefined;
}

export async function callAccountHost(relay: AccountProxyRelay, targetDeviceId: string, request: object, signal?: AbortSignal): Promise<HostResult> {
  const timeout = AbortSignal.timeout(25000);
  const response = await fetch(`${relay.url}/api/rabilink/device/api`, {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "x-rabilink-token": relay.token, "content-type": "application/json", "x-rabi-timeout-ms": "24000" }, body: JSON.stringify({ targetDeviceId, request })
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Account Relay HTTP ${response.status}.`); }
  const result = await response.json() as { data?: { structuredContent?: HostResult } };
  if (!result.data?.structuredContent) throw new Error("Invalid account Relay response.");
  return result.data.structuredContent;
}

function servicePath(service: string, path: string) {
  if (service === "resources") return `/api/resource-cache/data${path}`;
  if (service === "manager" || service === "persona") return path;
  throw new TunnelDenied("peer_service_denied");
}

function responseBody(result: HostResult) {
  const raw = result.data as { bodyBase64?: unknown; contentType?: unknown } | null;
  if (typeof raw?.bodyBase64 !== "string" || typeof raw.contentType !== "string") throw new Error("Invalid account Relay response body.");
  return Buffer.from(raw.bodyBase64, "base64");
}

export async function fetchAccountHost(relay: AccountProxyRelay, deviceId: string, service: string, path: string, init: RequestInit, authorize: () => void) {
  authorize();
  if (service === "speech") {
    const target = `${relay.url}/api/rabilink/speech${path}`;
    const headers = new Headers();
    for (const [key, value] of new Headers(init.headers)) if (apiRequestHeaderAllowed(key)) headers.set(key, value);
    const timeoutMs = getTimeoutMs("backend.peerTunnel.speechAdapter.binary.timeoutMs", 190000);
    headers.set("x-rabi-timeout-ms", String(timeoutMs));
    headers.set("x-rabilink-token", relay.token);
    headers.set("x-rabilink-peer-target", deviceId);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(target, { method: init.method, body: init.body, headers, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    try { authorize(); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  }
  const method = (init.method || "GET").toUpperCase();
  const headers = Object.fromEntries([...new Headers(init.headers)].filter(([key]) => apiRequestHeaderAllowed(key)));
  const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer());
  if (body && body.length > BODY_LIMIT) throw new Error("Account Relay request body is too large.");
  const bodyBase64 = body?.toString("base64");
  authorize();
  const result = await callAccountHost(relay, deviceId, {
    method, path: servicePath(service, path), headers,
    ...(bodyBase64 ? { bodyBase64 } : {}),
    ...(["GET", "HEAD", "OPTIONS"].includes(method) ? {} : { operationId: headers["idempotency-key"] || randomUUID() })
  }, init.signal || undefined);
  authorize();
  if (!result.statusCode) {
    const failure = unconfirmedFailure(result);
    if (!failure) throw new Error(result.uncertain ? "Remote outcome is uncertain." : "Remote response unavailable.");
    return new Response(JSON.stringify({ code: -1, error: failure.code, message: failure.message, uncertain: failure.uncertain }),
      { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const response = method === "HEAD" || [204, 205, 304].includes(result.statusCode) ? null : new Uint8Array(responseBody(result));
  return new Response(response, { status: result.statusCode, headers: result.headers });
}

export async function proxyAccountHost(input: ApiHttpProxyInput, relay: AccountProxyRelay, authorize: () => void) {
  if (rabiLinkTransportAssertionPresent(input.request)) throw new TunnelDenied("peer_service_denied");
  const method = input.request.method || "GET";
  const path = servicePath(input.path.service!, `/${input.path.path}${input.url.search}`);
  const expected = peerProxyRequestHeaders(input.request.headers);
  const headers = Object.fromEntries(Object.entries(expected)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value] as const)
    .filter(([key, value]) => apiRequestHeaderAllowed(key) && value.length <= 512));
  if (headers.accept?.includes("text/event-stream")) throw new TunnelDenied("peer_service_denied");
  const bodyBase64 = await requestBody(input);
  authorize();
  const result = await callAccountHost(relay, input.path.deviceId!, {
    method, path, headers,
    ...(bodyBase64 ? { bodyBase64 } : {}),
    ...(["GET", "HEAD", "OPTIONS"].includes(method) ? {} : { operationId: headers["idempotency-key"] || randomUUID() })
  }, input.signal);
  authorize();
  if (!result.statusCode) {
    const responseHeaders = { "content-type": "application/json", "cache-control": "no-store" };
    const failure = unconfirmedFailure(result);
    const body = failure ? { code: -1, error: failure.code, message: failure.message, uncertain: failure.uncertain }
      : { error: "Remote response unavailable.", uncertain: result.uncertain === true };
    input.prepareResponse(502, responseHeaders);
    input.response.writeHead(502, responseHeaders).end(JSON.stringify(body));
    return;
  }
  const responseHeaders = tunnelHeaders(result.headers || {}, true);
  const body = responseBody(result);
  input.prepareResponse(result.statusCode, responseHeaders);
  input.response.writeHead(result.statusCode, responseHeaders).end(method === "HEAD" ? undefined : body);
}
