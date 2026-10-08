import { KNOWLEDGE_PATH, executeKnowledgeQueue, probeKnowledgeBridge, isCanonicalKnowledgeDeviceId, type KnowledgeRuntimeContext, type KnowledgeQueueMetadata } from './rabiLinkKnowledgeRuntime.js';
import { APPLICATION_ACCESS_CAPABILITY } from '../peerTunnel/runtime.js';
import { PERSONA_REFERENCE_CAPABILITY } from "../shared/personaPeerService.js";
import { normalizeRabiPcVersion, rabiPcVersionAdvertisement } from "../shared/rabiPcVersionContract.js";
const knowledgeReady = new WeakMap<RabiLinkRelayRuntimeConfig, boolean>();
type RelayProxyRequest = {
  knowledge?: KnowledgeQueueMetadata;
  nonReplayable?: boolean;
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

export type RabiLinkRelayRuntimeConfig = {
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  deviceGuid: string;
  deviceName: string;
  /** The package version of the running Manager, never a configured peer version. */
  rabiPcVersion?: string;
  claimWaitMs: number;
  localWebguiUrl: string;
  /** Direct Manager endpoints advertised only to PCs using the same application token. */
  peerUrls?: string[];
  localSpeechUrl: string;
};

export type RabiLinkRelayRuntimeStatus = {
  state: "disabled" | "incomplete" | "connecting" | "online" | "error";
  message: string;
  knowledgeBridgeReady?: boolean;
  capabilities?: string[];
  lastConnectedAt?: string;
  lastSuccessAt?: string;
  error?: string;
};

export type RabiLinkRelayRuntimeOptions = {
  knowledge?: KnowledgeRuntimeContext;
  localRequestTimeoutMs?: number;
  localRequestAttempts?: number;
  localSpeechRequestTimeoutMs?: number;
  relayWriteTimeoutMs?: number;
  relayWriteAttempts?: number;
  channelRetryDelayMs?: number;
  onStatus?: (status: RabiLinkRelayRuntimeStatus) => void;
  onEvent?: (eventType: string, data: Record<string, unknown>) => void;
};

const RETRY_DELAY_MS = 3000;
const MAX_CHANNEL_RETRY_DELAY_MS = 30_000;
const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_LOCAL_REQUEST_ATTEMPTS = 3;
const DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS = 180000;
const DEFAULT_RELAY_WRITE_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_WRITE_ATTEMPTS = 4;
const WEBGUI_EVENT_STREAM_PATHS = ["/api/events", "/api/speech/events"] as const;

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || !("cause" in error) || !error.cause) return message;
  const cause = error.cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const causeCode = typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code?: unknown }).code ?? "").trim()
    : "";
  const detail = [causeCode, causeMessage].filter(Boolean).join(" ");
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) return finish();
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function proxyRequests(body: Record<string, unknown>): RelayProxyRequest[] {
  const requests = Array.isArray(body.requests) ? body.requests : [];
  return requests.filter((item): item is RelayProxyRequest => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

async function relayJson(
  config: RabiLinkRelayRuntimeConfig,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 0
): Promise<Record<string, unknown>> {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller?.abort(upstreamSignal?.reason);
  if (controller && upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`RabiLink Relay request timed out after ${timeoutMs} ms.`)), timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(`${config.url}${pathname}`, {
      ...init,
      signal: controller?.signal || upstreamSignal
    });
  } finally {
    if (timer) clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`RabiLink Relay returned invalid JSON (${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `${response.status} ${response.statusText}`));
  }
  return body;
}

async function consumeRelayEvents(
  config: RabiLinkRelayRuntimeConfig,
  signal: AbortSignal,
  onEvent: (eventType: string, data: Record<string, unknown>) => void
): Promise<void> {
  const params = new URLSearchParams({
    ...workerIdentity(config),
    deviceName: config.deviceName,
    capabilities: workerCapabilities(config)
  });
  appendWorkerDiscovery(params, config);
  const response = await fetch(`${config.url}/api/rabilink/events?${params}`, {
    method: "GET",
    headers: { ...relayHeaders(config), accept: "text/event-stream" },
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`RabiLink Relay event stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let hasEventFields = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (hasEventFields) onEvent(eventType, parseEventData(dataLines.join("\n")));
          eventType = "message";
          dataLines = [];
          hasEventFields = false;
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim() || "message";
          hasEventFields = true;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          hasEventFields = true;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch signal may already have closed the Relay stream.
    }
  }
}

async function publishWebguiEvent(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  eventType: string,
  data: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, "/worker/webgui-events", {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ streamPath, eventType, data, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

function parseEventData(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

async function consumeLocalWebguiEvents(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  signal: AbortSignal,
  onEvent: (eventType: string, data: Record<string, unknown>) => Promise<void>
): Promise<void> {
  const response = await fetch(safeLocalUrl(config, streamPath), {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "user-agent": "RabiRoute/1.0"
    },
    signal
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !response.body || !contentType.startsWith("text/event-stream")) {
    throw new Error(`Local Manager event stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let hasEventFields = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (hasEventFields) await onEvent(eventType, parseEventData(dataLines.join("\n")));
          eventType = "message";
          dataLines = [];
          hasEventFields = false;
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim() || "message";
          hasEventFields = true;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          hasEventFields = true;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The runtime stop signal may already have closed the local stream.
    }
  }
}

async function forwardLocalWebguiEvents(
  config: RabiLinkRelayRuntimeConfig,
  streamPath: string,
  signal: AbortSignal,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs" | "channelRetryDelayMs">>,
  onOwnerEvent: (eventType: string, data: Record<string, unknown>) => Promise<void>,
  onUnavailable: () => void
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await consumeLocalWebguiEvents(
        config,
        streamPath,
        signal,
        async (eventType, data) => {
          if (eventType === "ready") failures = 0;
          await onOwnerEvent(eventType, data);
          if (eventType !== "ready" && !signal.aborted) await publishWebguiEvent(config, streamPath, eventType, data, options, signal);
        }
      );
      if (!signal.aborted) throw new Error("Local Manager event stream closed.");
    } catch (error) {
      if (signal.aborted || abortError(error)) return;
      onUnavailable();
      failures += 1;
      await delay(Math.min(options.channelRetryDelayMs * failures, MAX_CHANNEL_RETRY_DELAY_MS), signal);
      continue;
    }
    failures = 0;
  }
}

async function relayJsonReliably(
  config: RabiLinkRelayRuntimeConfig,
  pathname: string,
  init: RequestInit,
  attempts: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new Error("RabiLink Relay runtime stopped.");
    try {
      return await relayJson(config, pathname, { ...init, signal }, timeoutMs);
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw error;
      if (attempt < attempts) await delay(150 * attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "RabiLink Relay request failed."));
}

async function localFetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Local ${label} request timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function relayHeaders(config: RabiLinkRelayRuntimeConfig, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RabiLink-Token": config.token,
    "User-Agent": "RabiRoute/1.0"
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

function workerIdentity(config: RabiLinkRelayRuntimeConfig): Record<string, string> {
  return {
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid
  };
}

function appendWorkerDiscovery(params: URLSearchParams, config: RabiLinkRelayRuntimeConfig): void {
  params.set("deviceKind", "pc");
  if (config.peerUrls?.length) params.set("peerUrls", JSON.stringify(config.peerUrls));
}

type SpeechAdvertisement = { available: boolean; speechAvailable: boolean };
const asrAdvertisements = new WeakMap<RabiLinkRelayRuntimeConfig, SpeechAdvertisement>();

async function probeSpeechAdvertisement(config: RabiLinkRelayRuntimeConfig, signal: AbortSignal): Promise<SpeechAdvertisement> {
  if (!config.localSpeechUrl || signal.aborted) return { available: false, speechAvailable: false };
  let available = false;
  let speechAvailable = false;
  try {
    const response = await fetch(`${config.localSpeechUrl}/v1/capabilities`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: "error"
    });
    if (response.ok) {
      const body = await response.json() as { providers?: { asr?: Record<string, { enabled?: boolean }> } };
      speechAvailable = !!body.providers && typeof body.providers === "object";
      available = speechAvailable && Object.values(body.providers?.asr || {}).some(provider => provider.enabled !== false);
    }
  } catch { /* An unavailable local service must not be advertised as usable ASR. */ }
  return { available, speechAvailable };
}

function workerCapabilities(config: RabiLinkRelayRuntimeConfig): string {
  return ["wearable-observation-policy-v1", "webgui", "video-direct", "peer-rpc-v1", "peer-tunnel-v1", APPLICATION_ACCESS_CAPABILITY, PERSONA_REFERENCE_CAPABILITY, rabiPcVersionAdvertisement(config.rabiPcVersion), asrAdvertisements.get(config)?.speechAvailable ? "speech" : "", knowledgeReady.get(config) ? "knowledgebridge" : "", asrAdvertisements.get(config)?.available ? "asr" : ""]
    .filter(Boolean)
    .join(",");
}

function safeLocalUrl(config: RabiLinkRelayRuntimeConfig, pathname: string): string {
  const base = new URL(config.localWebguiUrl);
  const localUrl = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  localUrl.protocol = base.protocol;
  localUrl.host = base.host;
  // Decode repeatedly so encoded separators, dot segments and nested escapes cannot
  // turn a retired API into an ordinary WebGUI request at a downstream boundary.
  let encodedPath = localUrl.pathname;
  while (true) {
    const decodedPath = decodeURIComponent(encodedPath);
    const normalizedPath = new URL(`/${decodedPath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "")}`, base).pathname;
    const checkedPath = normalizedPath.replace(/\/+$/, "").toLowerCase();
    if (checkedPath === "/api/persona-sync" || checkedPath.startsWith("/api/persona-sync/")) {
      throw new Error("Persona synchronization API has been removed.");
    }
    if (checkedPath === "/api/agent/qq/history" || checkedPath.startsWith("/api/agent/qq/messages/")) {
      throw new Error("QQ message and attachment reads require direct local management access.");
    }
    if (decodedPath === encodedPath || !/%[0-9a-f]{2}/i.test(decodedPath)) break;
    encodedPath = decodedPath;
  }
  return localUrl.toString();
}

function localPathname(value: string): string {
  try {
    return new URL(value || "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function isWebguiEventStreamProxy(localPath: string, headers: Record<string, string>): boolean {
  const pathname = localPathname(localPath);
  return WEBGUI_EVENT_STREAM_PATHS.some(streamPath => streamPath === pathname)
    || String(headers.accept || "").toLowerCase().includes("text/event-stream");
}

function safeSpeechUrl(config: RabiLinkRelayRuntimeConfig, pathname: string): string {
  const base = new URL(config.localSpeechUrl);
  const localUrl = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  localUrl.protocol = base.protocol;
  localUrl.host = base.host;
  return localUrl.toString();
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function compactResponse(
  method: string,
  localPath: string,
  statusCode: number,
  body: Buffer,
  requestHeaders: Record<string, string>
): Buffer {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase())) return body;
  if (!localPath.startsWith("/gateways") && !localPath.startsWith("/manager-config")) return body;
  if (statusCode < 200 || statusCode >= 300) return body;
  if (requestHeaders["idempotency-key"] || requestHeaders["if-match"]) return body;
  return Buffer.from(JSON.stringify({ code: 0, ok: true }), "utf8");
}

async function finishWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  requestId: string,
  body: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, `/worker/webgui-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ ...body, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

async function proxyWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  request: RelayProxyRequest,
  options: Required<Omit<RabiLinkRelayRuntimeOptions, 'knowledge'>> & Pick<RabiLinkRelayRuntimeOptions, 'knowledge'>,
  signal: AbortSignal,
  onKnowledgeUnavailable: () => void
): Promise<void> {
  const requestId = stringValue(request.id);
  if (!requestId || signal.aborted) return;
  try {
    const method = stringValue(request.method).toUpperCase() || "GET";
    const localPath = stringValue(request.path) || "/";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (["accept", "content-type", "user-agent", "range", "if-range", "idempotency-key", "if-match", "x-rabiroute-expected-application-generation-id", "x-rabiroute-expected-manager-instance-id"].includes(lower)) {
        headers[lower] = String(value || "");
      }
    }
    headers["x-rabiroute-relay-proxy"] = "1";
    if (isWebguiEventStreamProxy(localPath, headers)) {
      throw new Error("SSE event streams must use the Relay event channel instead of the finite WebGUI response proxy.");
    }
    const requestBody = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    if (localPath.split('?')[0].startsWith('/__rabilink/')) {
      let result: unknown;
      let statusCode = 200;
      try {
        if (localPath !== KNOWLEDGE_PATH || method !== 'POST' || !request.knowledge || !requestBody || requestBody.length > 65536) throw new Error('KNOWLEDGE_REQUEST_DENIED');
        result = await executeKnowledgeQueue(options.knowledge, config.deviceId, request.knowledge, JSON.parse(requestBody.toString('utf8')), request.nonReplayable === true);
        const envelope = result as { code?: string; uncertain?: boolean; structuredContent?: { code?: string; uncertain?: boolean } };
        const receipt = envelope?.structuredContent ?? envelope;
        if (envelope?.code === 'KNOWLEDGE_TRANSPORT_FAILED' || receipt?.code === 'KNOWLEDGE_TRANSPORT_FAILED' || receipt?.uncertain === true) onKnowledgeUnavailable();
      } catch { statusCode = 403; result = { ok: false, code: 'KNOWLEDGE_REQUEST_DENIED', uncertain: false }; }
      if (!signal.aborted) await finishWebguiRequest(config, requestId, { ok: true, statusCode, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(JSON.stringify(result)).toString('base64') }, options, signal);
      return;
    }
    const localUrl = safeLocalUrl(config, localPath);
    const requestAttempts = method === "GET" || method === "HEAD" ? options.localRequestAttempts : 1;
    let response: Response | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
      try {
        response = await localFetchWithTimeout(localUrl, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : requestBody,
          signal
        }, options.localRequestTimeoutMs, "Rabi WebGUI");
        break;
      } catch (error) {
        lastError = error;
        if (signal.aborted) return;
        if (attempt < requestAttempts) await delay(100 * attempt, signal);
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error("Local Rabi WebGUI request failed.");
    }
    if (signal.aborted) return;
    const responseContentType = response.headers.get("content-type") || "";
    if (responseContentType.toLowerCase().startsWith("text/event-stream")) {
      try {
        await response.body?.cancel();
      } catch {
        // The stream may already have closed while the protocol mismatch was detected.
      }
      throw new Error("SSE event streams must use the Relay event channel instead of the finite WebGUI response proxy.");
    }
    const rawBody = Buffer.from(await response.arrayBuffer());
    if (signal.aborted) return;
    const responseBody = compactResponse(method, localPath, response.status, rawBody, headers);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishWebguiRequest(config, requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: responseBody.toString("base64")
    }, options, signal);
  } catch (error) {
    if (signal.aborted) return;
    await finishWebguiRequest(config, requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      bodyBase64: Buffer.from(error instanceof Error ? error.message : String(error), "utf8").toString("base64"),
      error: error instanceof Error ? error.message : String(error)
    }, options, signal);
  }
}

async function claimWebguiRequests(
  config: RabiLinkRelayRuntimeConfig,
  waitMs: number,
  signal: AbortSignal
): Promise<RelayProxyRequest[]> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid,
    deviceName: config.deviceName,
    waitMs: String(waitMs),
    capabilities: workerCapabilities(config)
  });
  appendWorkerDiscovery(params, config);
  const body = await relayJson(config, `/worker/webgui-requests?${params}`, {
    method: "GET",
    headers: relayHeaders(config),
    signal
  });
  return proxyRequests(body);
}

async function finishSpeechRequest(
  config: RabiLinkRelayRuntimeConfig,
  requestId: string,
  body: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>,
  signal: AbortSignal
): Promise<void> {
  await relayJsonReliably(config, `/worker/speech-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ ...body, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs, signal);
}

async function proxySpeechRequest(
  config: RabiLinkRelayRuntimeConfig,
  request: RelayProxyRequest,
  options: Required<Omit<RabiLinkRelayRuntimeOptions, 'knowledge'>> & Pick<RabiLinkRelayRuntimeOptions, 'knowledge'>,
  signal: AbortSignal
): Promise<void> {
  const requestId = stringValue(request.id);
  if (!requestId || signal.aborted) return;
  try {
    const method = stringValue(request.method).toUpperCase() || "GET";
    const localPath = stringValue(request.path) || "/";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (["accept", "content-type", "user-agent"].includes(lower)) headers[lower] = String(value || "");
    }
    const requestBody = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    const managerVideoOffer = method === "POST" && localPath === "/api/rabilink/video/offer";
    if (!managerVideoOffer && !Boolean(config.localSpeechUrl)) throw new Error("Local speech service is not configured.");
    const managerSpeechIngress = localPath === "/api/speech/messages" || managerVideoOffer;
    if (!managerSpeechIngress) headers["x-rabilink-tunnel-local"] = "relay-speech";
    const response = await localFetchWithTimeout(
      managerSpeechIngress ? safeLocalUrl(config, localPath) : safeSpeechUrl(config, localPath), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody,
      signal
    }, options.localSpeechRequestTimeoutMs, managerSpeechIngress ? "Rabi Manager speech ingress" : "RabiSpeech");
    if (signal.aborted) return;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishSpeechRequest(config, requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64")
    }, options, signal);
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    await finishSpeechRequest(config, requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
      bodyBase64: Buffer.from(JSON.stringify({ error: { message, type: "local_speech_proxy_error" } }), "utf8").toString("base64"),
      error: message
    }, options, signal);
  }
}

async function claimSpeechRequests(
  config: RabiLinkRelayRuntimeConfig,
  waitMs: number,
  signal: AbortSignal
): Promise<RelayProxyRequest[]> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid,
    deviceName: config.deviceName,
    waitMs: String(waitMs),
    capabilities: workerCapabilities(config)
  });
  appendWorkerDiscovery(params, config);
  const body = await relayJson(config, `/worker/speech-requests?${params}`, {
    method: "GET",
    headers: relayHeaders(config),
    signal
  });
  return proxyRequests(body);
}

function normalizeConfig(config: RabiLinkRelayRuntimeConfig): RabiLinkRelayRuntimeConfig {
  return {
    ...config,
    url: normalizeBaseUrl(config.url),
    token: config.token.trim(),
    deviceId: config.deviceId.trim(),
    deviceGuid: config.deviceGuid.trim(),
    deviceName: config.deviceName.trim(),
    rabiPcVersion: normalizeRabiPcVersion(config.rabiPcVersion) ?? undefined,
    claimWaitMs: Math.max(0, Math.min(60000, Number(config.claimWaitMs) || 0)),
    localWebguiUrl: normalizeBaseUrl(config.localWebguiUrl),
    peerUrls: [...new Set((config.peerUrls || []).map(normalizeBaseUrl).filter(Boolean))].slice(0, 8),
    localSpeechUrl: normalizeBaseUrl(config.localSpeechUrl)
  };
}

export class RabiLinkRelayRuntime {
  private currentConfig: RabiLinkRelayRuntimeConfig | null = null;
  private signature = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private runFlight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private runtimeStatus: RabiLinkRelayRuntimeStatus = {
    state: "disabled",
    message: "RabiLink Relay 全局连接已关闭。"
  };
  private readonly options: Required<Omit<RabiLinkRelayRuntimeOptions, 'knowledge'>> & Pick<RabiLinkRelayRuntimeOptions, 'knowledge'>;
  private readonly onStatus?: (status: RabiLinkRelayRuntimeStatus) => void;
  private readonly onEvent?: (eventType: string, data: Record<string, unknown>) => void;

  constructor(options: RabiLinkRelayRuntimeOptions = {}) {
    this.onStatus = options.onStatus;
    this.onEvent = options.onEvent;
    this.options = {
      knowledge: options.knowledge,
      localRequestTimeoutMs: Math.max(100, Number(options.localRequestTimeoutMs) || DEFAULT_LOCAL_REQUEST_TIMEOUT_MS),
      localRequestAttempts: Math.max(1, Math.min(5, Number(options.localRequestAttempts) || DEFAULT_LOCAL_REQUEST_ATTEMPTS)),
      localSpeechRequestTimeoutMs: Math.max(1000, Number(options.localSpeechRequestTimeoutMs) || DEFAULT_LOCAL_SPEECH_REQUEST_TIMEOUT_MS),
      relayWriteTimeoutMs: Math.max(100, Number(options.relayWriteTimeoutMs) || DEFAULT_RELAY_WRITE_TIMEOUT_MS),
      relayWriteAttempts: Math.max(1, Math.min(5, Number(options.relayWriteAttempts) || DEFAULT_RELAY_WRITE_ATTEMPTS)),
      channelRetryDelayMs: Math.max(10, Math.min(
        MAX_CHANNEL_RETRY_DELAY_MS,
        Number(options.channelRetryDelayMs) || RETRY_DELAY_MS
      )),
      onStatus: options.onStatus ?? (() => undefined),
      onEvent: options.onEvent ?? (() => undefined)
    };
  }

  private setStatus(status: RabiLinkRelayRuntimeStatus): void {
    this.runtimeStatus = status;
    this.onStatus?.(this.status());
  }

  status(): RabiLinkRelayRuntimeStatus {
    const config = this.currentConfig;
    const ready = !!config?.enabled && knowledgeReady.get(config) === true;
    return { ...this.runtimeStatus, knowledgeBridgeReady: ready, capabilities: config ? workerCapabilities(config).split(',').filter(Boolean) : [] };
  }

  sync(input: RabiLinkRelayRuntimeConfig): Promise<void> {
    const config = normalizeConfig(input);
    const signature = JSON.stringify(config);
    if (signature === this.signature) {
      return this.stopFlight?.then(() => undefined) ?? Promise.resolve();
    }
    this.signature = signature;
    if (this.stopFlight) {
      return this.stopFlight.then(async () => {
        if (this.signature === signature) await this.applyConfig(config);
      });
    }
    return this.applyConfig(config);
  }

  stop(): Promise<void> {
    this.signature = "";
    if (this.stopFlight) return this.stopFlight;
    const runFlight = this.stopLoop();
    const stopFlight = (async () => {
      await runFlight?.catch(() => {});
      this.setStatus({ state: "disabled", message: "RabiLink Relay 全局连接已关闭。" });
    })();
    const tracked = stopFlight.finally(() => {
      if (this.stopFlight === tracked) this.stopFlight = null;
    });
    this.stopFlight = tracked;
    return tracked;
  }

  private applyConfig(config: RabiLinkRelayRuntimeConfig): Promise<void> {
    const previousRun = this.stopLoop();
    const previousDone = previousRun?.catch(() => {}) ?? Promise.resolve();
    if (!config.enabled) {
      this.setStatus({ state: "disabled", message: "RabiLink Relay 全局连接已关闭。" });
      return previousDone;
    }
    if (!config.url || !config.token) {
      this.setStatus({ state: "incomplete", message: "开启 Relay 前需要填写服务器地址和应用 token。" });
      return previousDone;
    }
    if (!isLoopbackUrl(config.localWebguiUrl)) {
      this.setStatus({ state: "incomplete", message: "本机 Rabi WebGUI 地址必须使用 127.0.0.1、localhost 或 ::1。" });
      return previousDone;
    }
    if (Boolean(config.localSpeechUrl) && !isLoopbackUrl(config.localSpeechUrl)) {
      this.setStatus({ state: "incomplete", message: "本机语音服务地址必须使用 127.0.0.1、localhost 或 ::1。" });
      return previousDone;
    }

    this.currentConfig = config;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus({ state: "connecting", message: "正在连接 RabiLink Relay..." });
    const runFlight = previousDone
      .then(() => {
        if (!this.active(generation, controller.signal)) return;
        return this.run(config, generation, controller.signal);
      });
    const tracked = runFlight.finally(() => {
      if (this.runFlight === tracked) this.runFlight = null;
    });
    this.runFlight = tracked;
    return previousDone;
  }

  private stopLoop(): Promise<void> | null {
    this.currentConfig = null;
    this.generation += 1;
    this.controller?.abort(new Error("RabiLink Relay runtime stopped."));
    this.controller = null;
    return this.runFlight;
  }

  private active(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private markOnline(speechEnabled: boolean): void {
    const now = new Date().toISOString();
    this.setStatus({
      state: "online",
      message: speechEnabled
        ? "RabiLink Relay 已连接，本机 WebGUI 与语音能力已在服务器上线。"
        : "RabiLink Relay 已连接，本机已在服务器上线。",
      lastConnectedAt: this.runtimeStatus.lastConnectedAt || now,
      lastSuccessAt: now
    });
  }

  private async drainChannel(
    signal: AbortSignal,
    claim: (waitMs: number, signal: AbortSignal) => Promise<RelayProxyRequest[]>,
    proxy: (request: RelayProxyRequest) => Promise<void>
  ): Promise<void> {
    while (!signal.aborted) {
      const requests = await claim(0, signal);
      if (requests.length === 0) return;
      for (const request of requests) await proxy(request);
    }
  }

  private async run(config: RabiLinkRelayRuntimeConfig, generation: number, signal: AbortSignal): Promise<void> {
    let webguiDrain: Promise<void> | null = null;
    let speechDrain: Promise<void> | null = null;
    let webguiDrainFailures = 0;
    let speechDrainFailures = 0;
    let relayReady = false;
    let knowledgeAvailabilityEpoch = 0;
    let speechAvailabilityEpoch = 0;
    let capabilityFlight: Promise<void> | null = null;
    let pendingKnowledge = false;
    let pendingSpeech = false;
    let publishedCapabilities = workerCapabilities(config);
    const webguiEvents = new Map<string, Promise<void>>();
    const markChannelsOnline = (): void => {
      if (webguiDrainFailures === 0
        && (!Boolean(config.localSpeechUrl) || speechDrainFailures === 0)
        && this.active(generation, signal)) {
        this.markOnline(asrAdvertisements.get(config)?.speechAvailable === true);
      }
    };
    const startWebguiEvents = (): void => {
      if (signal.aborted) return;
      for (const streamPath of WEBGUI_EVENT_STREAM_PATHS) {
        if (webguiEvents.has(streamPath)) continue;
        const running = forwardLocalWebguiEvents(config, streamPath, signal, this.options,
          async eventType => {
            if (!this.active(generation, signal)) return;
            if (streamPath === "/api/events" && (eventType === "ready" || eventType === "route_catalog_startup_changed")) {
              void refreshCapabilities(true, false).catch(() => {});
            } else if (streamPath === "/api/events" && eventType === "speech_model_management_changed"
              || streamPath === "/api/speech/events" && (eventType === "ready" || eventType === "capabilities_changed")) {
              void refreshCapabilities(false, true).catch(() => {});
            }
          }, () => {
            if (!this.active(generation, signal)) return;
            if (streamPath === "/api/events") {
              knowledgeAvailabilityEpoch++;
              knowledgeReady.set(config, false);
            } else {
              speechAvailabilityEpoch++;
              asrAdvertisements.set(config, { available: false, speechAvailable: false });
            }
            publishCapabilities();
          })
          .finally(() => webguiEvents.delete(streamPath));
        webguiEvents.set(streamPath, running);
      }
    };
    const drainWebgui = (): void => {
      if (webguiDrain || !this.active(generation, signal)) return;
      let retry = false;
      const attempt: Promise<void> = this.drainChannel(
        signal,
        (waitMs, channelSignal) => claimWebguiRequests(config, waitMs, channelSignal),
        (request) => proxyWebguiRequest(config, request, this.options, signal, () => {
          if (!this.active(generation, signal)) return;
          knowledgeAvailabilityEpoch++;
          knowledgeReady.set(config, false);
          publishCapabilities();
        })
      ).then(() => {
        webguiDrainFailures = 0;
        markChannelsOnline();
      }).catch(async error => {
        if (!this.active(generation, signal)) return;
        webguiDrainFailures += 1;
        retry = true;
        const message = runtimeErrorMessage(error);
        this.setStatus({
          state: "error",
          message: `RabiLink WebGUI 事件处理失败：${message}`,
          lastConnectedAt: this.runtimeStatus.lastConnectedAt,
          lastSuccessAt: this.runtimeStatus.lastSuccessAt,
          error: message
        });
        await delay(Math.min(
          this.options.channelRetryDelayMs * webguiDrainFailures,
          MAX_CHANNEL_RETRY_DELAY_MS
        ), signal);
      }).finally(() => {
        if (webguiDrain === attempt) webguiDrain = null;
        if (retry && this.active(generation, signal)) drainWebgui();
      });
      webguiDrain = attempt;
    };
    const drainSpeech = (): void => {
      if (speechDrain || !this.active(generation, signal)) return;
      let retry = false;
      const attempt: Promise<void> = this.drainChannel(
        signal,
        (waitMs, channelSignal) => claimSpeechRequests(config, waitMs, channelSignal),
        (request) => proxySpeechRequest(config, request, this.options, signal)
      ).then(() => {
        speechDrainFailures = 0;
        markChannelsOnline();
      }).catch(async error => {
        if (!this.active(generation, signal)) return;
        speechDrainFailures += 1;
        retry = true;
        const message = runtimeErrorMessage(error);
        this.setStatus({
          state: "error",
          message: `RabiLink 语音事件处理失败：${message}`,
          lastConnectedAt: this.runtimeStatus.lastConnectedAt,
          lastSuccessAt: this.runtimeStatus.lastSuccessAt,
          error: message
        });
        await delay(Math.min(
          this.options.channelRetryDelayMs * speechDrainFailures,
          MAX_CHANNEL_RETRY_DELAY_MS
        ), signal);
      }).finally(() => {
        if (speechDrain === attempt) speechDrain = null;
        if (retry && this.active(generation, signal)) drainSpeech();
      });
      speechDrain = attempt;
    };
    const publishCapabilities = (): void => {
      if (!this.active(generation, signal)) return;
      const capabilities = workerCapabilities(config);
      if (publishedCapabilities === capabilities) return;
      publishedCapabilities = capabilities;
      this.onStatus?.(this.status());
      if (relayReady) { drainWebgui(); drainSpeech(); }
    };
    // Manager/Speech own readiness. Coalesce their events; idle connections never poll business state.
    const refreshCapabilities = (knowledge: boolean, speech: boolean): Promise<void> => {
      if (!this.active(generation, signal)) return Promise.resolve();
      pendingKnowledge ||= knowledge;
      pendingSpeech ||= speech;
      if (capabilityFlight) return capabilityFlight;
      const flight = (async () => {
        while (this.active(generation, signal) && (pendingKnowledge || pendingSpeech)) {
          const checkKnowledge = pendingKnowledge, checkSpeech = pendingSpeech;
          pendingKnowledge = pendingSpeech = false;
          if (checkKnowledge) {
            const epoch = knowledgeAvailabilityEpoch;
            const ready = isCanonicalKnowledgeDeviceId(config.deviceId) && await probeKnowledgeBridge(this.options.knowledge, signal);
            if (!this.active(generation, signal)) return;
            if (epoch === knowledgeAvailabilityEpoch) knowledgeReady.set(config, ready);
          }
          if (checkSpeech) {
            const epoch = speechAvailabilityEpoch;
            const advertisement = await probeSpeechAdvertisement(config, signal);
            if (!this.active(generation, signal)) return;
            if (epoch === speechAvailabilityEpoch) asrAdvertisements.set(config, advertisement);
          }
          publishCapabilities();
        }
      })();
      const tracked = flight.finally(() => { if (capabilityFlight === tracked) capabilityFlight = null; });
      capabilityFlight = tracked;
      return tracked;
    };
    await refreshCapabilities(true, true);
    if (!this.active(generation, signal)) return;
    try {
      while (this.active(generation, signal)) {
        try {
          await consumeRelayEvents(config, signal, (eventType, data) => {
            try {
              this.onEvent?.(eventType, data);
            } catch {
              // Relay ownership and proxy delivery do not depend on observers.
            }
            if (eventType === "ready") {
              relayReady = true;
              markChannelsOnline();
              startWebguiEvents();
              drainWebgui();
              drainSpeech();
            } else if (eventType === "webgui_available") {
              drainWebgui();
            } else if (eventType === "speech_available") {
              drainSpeech();
            }
          });
          if (this.active(generation, signal)) throw new Error("RabiLink Relay event stream closed.");
        } catch (error) {
          if (signal.aborted || abortError(error) || !this.active(generation, signal)) return;
          const message = runtimeErrorMessage(error);
          this.setStatus({
            state: "error",
            message: `RabiLink Relay 事件流连接失败：${message}`,
            lastConnectedAt: this.runtimeStatus.lastConnectedAt,
            lastSuccessAt: this.runtimeStatus.lastSuccessAt,
            error: message
          });
          await delay(RETRY_DELAY_MS, signal);
        }
      }
    } finally {
      await Promise.allSettled([
        ...(capabilityFlight ? [capabilityFlight] : []),
        ...webguiEvents.values(),
        ...(webguiDrain ? [webguiDrain] : []),
        ...(speechDrain ? [speechDrain] : [])
      ]);
    }
  }
}
