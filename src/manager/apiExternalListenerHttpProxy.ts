import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tunnelHeaders } from "../peerTunnel/http.js";
import { TUNNEL_STREAM_LIMITS } from "../peerTunnel/session.js";
import { registerApiHttpProxies } from "./apiHttpProxyBinding.js";
import { ApiContractError, apiDigest, compileApiContract, type ApiHttpProxyDefinition, type ApiHttpProxyInput, type ApiOperationRegistration } from "./apiOperationContract.js";
import type { ApiPublishedOperation } from "./apiOperationCatalog.js";
import type { ManagerPluginRouteDeclaration } from "./managerPluginRouteRegistry.js";

export const NATIVE_LISTENER_HTTP_PREFIX = "/api/native-listeners/";
export const NATIVE_LISTENER_PROXY_CONTRACT = "x-rabiroute-native-proxy-contract";
// Existing Manager Peer envelope budgets, never a native payload or whole-message ceiling.
const wire = TUNNEL_STREAM_LIMITS;
export type NativeHttpRequestFactory = (target: URL, options: http.RequestOptions) => http.ClientRequest;
type ManagerIdentity = Readonly<{ applicationGenerationId: string; managerInstanceId: string }>;

/** A versioned transport mapping to an already verified original owner, never a caller-selected URL. */
export function createExternalListenerHttpProxy(operations: readonly ApiPublishedOperation[], assertOwner: (operation: ApiPublishedOperation, started: boolean) => void,
  openRequest: NativeHttpRequestFactory = (target, options) => (target.protocol === "https:" ? https : http).request(target, options),
  identity: () => ManagerIdentity = () => ({ applicationGenerationId: "unmanaged", managerInstanceId: "unmanaged" })) {
  const admitted = new WeakMap<http.IncomingMessage, ManagerIdentity>();
  const entries = new Map<string, { routes: readonly ManagerPluginRouteDeclaration[]; registration: ApiOperationRegistration; access: NonNullable<ApiPublishedOperation["access"]> }>();
  const retiring = new Set<Promise<void>>();
  let published: readonly ApiPublishedOperation[] = [], cleanupFailure: unknown, cleanupFailed = false, closing = false, disposal: Promise<void> | undefined;
  const retire = (registration: ApiOperationRegistration) => {
    const stopped = registration.dispose(); retiring.add(stopped);
    void stopped.then(() => retiring.delete(stopped), error => {
      if (!cleanupFailed) { cleanupFailed = true; cleanupFailure = error; }
      retiring.delete(stopped);
    });
  };
  const drainRetired = async () => {
    while (retiring.size) await Promise.allSettled([...retiring]);
    if (cleanupFailed) throw new AggregateError([cleanupFailure], "Original native HTTP producer cleanup failed.");
  };
  const update = (current: readonly ApiPublishedOperation[]) => {
  if (closing) return;
  const active = new Set<string>();
  published = current.map(operation => {
    const binding = operation.binding;
    // Protocol authentication is not replaced by a node credential. Native credential
    // inputs remain direct-only until their separate connector is explicitly supported.
    if (!binding || binding.invocation !== "native" || binding.authentication.kind !== "none" || operation.contract.transport !== "http") return operation;
    const key = apiDigest({ contract: operation.contractDigest, binding }); active.add(key);
    const existing = entries.get(key); if (existing) return { ...operation, access: existing.access };
    const prefix = NATIVE_LISTENER_HTTP_PREFIX + binding.leaseId;
    const { deadlineMs: _nativeDeadline, ...nativeRequest } = operation.contract.request;
    const id = "native.http." + createHash("sha256").update(binding.leaseId + "\n" + operation.contract.operationId).digest("hex").slice(0, 32);
    const contract: ApiHttpProxyDefinition["contract"] = {
      operationId: id, contractVersion: "1.0.0", method: operation.contract.method, pathTemplate: prefix + operation.contract.pathTemplate,
      exposure: "internal", transport: "http", description: "Opaque native HTTP transport to the original registered listener owner.",
      httpProxy: { wire, completion: "Join the original native HTTP producer and response close.", cancellation: "Close the original native exchange; never replay a write." },
      request: { ...nativeRequest, headers: true, body: { kind: "passthrough" }, contractHeader: NATIVE_LISTENER_PROXY_CONTRACT },
      responses: { default: { mediaType: "*/*", passthrough: true } },
      effects: operation.contract.effects, recovery: operation.contract.recovery,
      validators: [{ id: "original-native-owner", description: `Original lease ${binding.leaseId}; original executable contract ${operation.contractDigest}.` }]
    };
    const digest = compileApiContract({ contract }).digest;
    let routes: readonly ManagerPluginRouteDeclaration[] = [];
    const registration = registerApiHttpProxies([{ contract, handler: input => forwardNativeHttp(input, operation, prefix, started => {
      const original = admitted.get(input.request), current = identity();
      if (!original || current.applicationGenerationId !== original.applicationGenerationId || current.managerInstanceId !== original.managerInstanceId) {
        throw new ApiContractError(409, "API_MANAGER_IDENTITY_CHANGED", "identity", operation.contract.operationId, started);
      }
      assertOwner(operation, started);
    }, openRequest) }], declared => { routes = declared; return () => { routes = []; }; });
    const access = { kind: "manager-native-http" as const, pathPrefix: prefix, contractHeader: NATIVE_LISTENER_PROXY_CONTRACT, contractDigest: digest };
    entries.set(key, { get routes() { return routes; }, registration, access });
    return { ...operation, access };
  });
  for (const [key, entry] of entries) if (!active.has(key)) { entries.delete(key); retire(entry.registration); }
  };
  update(operations);
  return Object.freeze({ get operations() { return published; }, update, drainRetired,
    handle(request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean {
      if (!url.pathname.startsWith(NATIVE_LISTENER_HTTP_PREFIX)) return false;
      for (const wildcard of [false, true]) for (const entry of entries.values()) for (const route of entry.routes) {
        const operation = route.operation!;
        if ((operation.contract.method === "*") === wildcard && (operation.contract.method === "*" || operation.contract.method === request.method)
          && operation.pathPattern.test(url.pathname)) {
          const current = identity(); admitted.set(request, { applicationGenerationId: current.applicationGenerationId, managerInstanceId: current.managerInstanceId });
          return route.handler(request, url, response);
        }
      }
      response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ code: -1, errorCode: "API_LISTENER_BINDING_CHANGED", retryable: false })); request.resume(); return true;
    },
    dispose(): Promise<void> {
      return disposal ??= (async () => {
        closing = true; for (const entry of entries.values()) retire(entry.registration); entries.clear();
        await drainRetired();
      })();
    }
  });
}

async function forwardNativeHttp(input: ApiHttpProxyInput, operation: ApiPublishedOperation, prefix: string, assertOwner: (started: boolean) => void, openRequest: NativeHttpRequestFactory): Promise<void> {
  let started = false;
  const assertCurrent = () => { input.assertCurrent(); assertOwner(started); };
  assertCurrent();
  const binding = operation.binding!, targetHeader = operation.contract.request.contractHeader ?? "x-rabiroute-api-contract";
  const expected = input.request.headers[targetHeader];
  if (expected !== undefined && expected !== operation.contractDigest) throw new ApiContractError(409, "API_CONTRACT_CHANGED", targetHeader, operation.contract.operationId);
  const origin = `${binding.address.protocol}://${binding.address.hostname ?? "127.0.0.1"}:${binding.address.port}`;
  const nativePath = input.url.pathname.slice(prefix.length);
  if (!nativePath.startsWith("/") || nativePath.startsWith("//")) throw new ApiContractError(400, "API_NATIVE_TARGET_INVALID", "path", operation.contract.operationId);
  // Assign only path/search onto the verified authority. Never interpret a caller
  // suffix as a relative URL capable of selecting another host or port.
  const target = new URL(origin); target.pathname = nativePath; target.search = input.url.search;
  const headers = tunnelHeaders(input.request.headers);
  for (const name of [NATIVE_LISTENER_PROXY_CONTRACT, "x-rabiroute-expected-application-generation-id", "x-rabiroute-expected-manager-instance-id", "x-rabiroute-agent-id", "x-rabiroute-agent-type", "x-rabiroute-session-id", "x-rabiroute-node-id", "x-rabiroute-peer-proxy", "x-rabiroute-relay-proxy"]) delete headers[name];
  headers["x-rabiroute-listener-lease"] = binding.leaseId; headers[targetHeader] = operation.contractDigest;
  headers["transfer-encoding"] = "chunked";
  const upstream = openRequest(target, { method: input.request.method, headers });
  const producerClosed = new Promise<void>(resolve => upstream.once("close", resolve));
  const cancelled = () => upstream.destroy(new Error("Native owner exchange cancelled."));
  input.signal.addEventListener("abort", cancelled, { once: true }); if (input.signal.aborted) cancelled();
  const guard = () => new Transform({ transform(bytes, _encoding, done) {
    try { assertCurrent(); done(null, bytes); } catch (error) { done(error as Error); }
  }, flush(done) { try { assertCurrent(); done(); } catch (error) { done(error as Error); } } });
  let response: http.IncomingMessage | undefined, sourceClosed: Promise<void> | undefined;
  const responseReady = new Promise<http.IncomingMessage>((resolve, reject) => { upstream.once("response", resolve); upstream.once("error", reject); });
  void responseReady.catch(() => {});
  // Observe both producers immediately, including a native early response while upload is still active.
  let upload: Promise<void> | undefined;
  try {
    assertCurrent(); started = true;
    upload = pipeline(input.request, guard(), upstream); void upload.catch(() => upstream.destroy());
    response = await responseReady; sourceClosed = new Promise<void>(resolve => response!.once("close", resolve));
    if (response.closed) sourceClosed = Promise.resolve();
    assertCurrent(); const responseHeaders = tunnelHeaders(response.headers, true);
    if (typeof response.headers["content-length"] === "string") responseHeaders["content-length"] = response.headers["content-length"];
    for (const name of Object.keys(responseHeaders)) {
      const repeated = response.headersDistinct[name]; if (repeated && repeated.length > 1) responseHeaders[name] = [...repeated];
    }
    const location = responseHeaders.location;
    if (typeof location === "string") {
      const destination = new URL(location, target);
      if (destination.origin === target.origin) responseHeaders.location = prefix + destination.pathname + destination.search + destination.hash;
    }
    input.prepareResponse(response.statusCode ?? 502, responseHeaders); input.response.writeHead(response.statusCode ?? 502, responseHeaders);
    await pipeline(response, guard(), input.response); await upload; assertCurrent();
  } catch (error) {
    if (started && !input.response.destroyed) input.response.destroy();
    throw error;
  } finally {
    input.signal.removeEventListener("abort", cancelled); upstream.destroy(); response?.destroy();
    await Promise.allSettled([producerClosed, ...(sourceClosed ? [sourceClosed] : []), ...(upload ? [upload] : [])]);
  }
}
