type RelayWebguiRequest = {
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
  claimWaitMs: number;
  localWebguiUrl: string;
};

export type RabiLinkRelayRuntimeStatus = {
  state: "disabled" | "incomplete" | "connecting" | "online" | "error";
  message: string;
  lastConnectedAt?: string;
  lastSuccessAt?: string;
  error?: string;
};

export type RabiLinkRelayRuntimeOptions = {
  localRequestTimeoutMs?: number;
  localRequestAttempts?: number;
  relayWriteTimeoutMs?: number;
  relayWriteAttempts?: number;
};

const RETRY_DELAY_MS = 3000;
const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_LOCAL_REQUEST_ATTEMPTS = 3;
const DEFAULT_RELAY_WRITE_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_WRITE_ATTEMPTS = 4;

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function webguiRequests(body: Record<string, unknown>): RelayWebguiRequest[] {
  const requests = Array.isArray(body.requests) ? body.requests : [];
  return requests.filter((item): item is RelayWebguiRequest => Boolean(item && typeof item === "object" && !Array.isArray(item)));
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

async function relayJsonReliably(
  config: RabiLinkRelayRuntimeConfig,
  pathname: string,
  init: RequestInit,
  attempts: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await relayJson(config, pathname, init, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "RabiLink Relay request failed."));
}

async function localFetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Local Rabi WebGUI request timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

function safeLocalUrl(config: RabiLinkRelayRuntimeConfig, pathname: string): string {
  const base = new URL(config.localWebguiUrl);
  const localUrl = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  localUrl.protocol = base.protocol;
  localUrl.host = base.host;
  return localUrl.toString();
}

function compactResponse(method: string, localPath: string, statusCode: number, body: Buffer): Buffer {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase())) return body;
  if (!localPath.startsWith("/gateways") && !localPath.startsWith("/manager-config")) return body;
  if (statusCode < 200 || statusCode >= 300) return body;
  return Buffer.from(JSON.stringify({ code: 0, ok: true }), "utf8");
}

async function finishWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  requestId: string,
  body: Record<string, unknown>,
  options: Required<Pick<RabiLinkRelayRuntimeOptions, "relayWriteAttempts" | "relayWriteTimeoutMs">>
): Promise<void> {
  await relayJsonReliably(config, `/worker/webgui-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(config, true),
    body: JSON.stringify({ ...body, ...workerIdentity(config) })
  }, options.relayWriteAttempts, options.relayWriteTimeoutMs);
}

async function proxyWebguiRequest(
  config: RabiLinkRelayRuntimeConfig,
  request: RelayWebguiRequest,
  options: Required<RabiLinkRelayRuntimeOptions>
): Promise<void> {
  const requestId = stringValue(request.id);
  if (!requestId) return;
  try {
    const method = stringValue(request.method).toUpperCase() || "GET";
    const localPath = stringValue(request.path) || "/";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (["accept", "content-type", "user-agent"].includes(lower)) headers[lower] = String(value || "");
    }
    const requestBody = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    const requestAttempts = method === "GET" || method === "HEAD" ? options.localRequestAttempts : 1;
    let response: Response | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
      try {
        response = await localFetchWithTimeout(safeLocalUrl(config, localPath), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : requestBody
        }, options.localRequestTimeoutMs);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < requestAttempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error("Local Rabi WebGUI request failed.");
    }
    const rawBody = Buffer.from(await response.arrayBuffer());
    const responseBody = compactResponse(method, localPath, response.status, rawBody);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishWebguiRequest(config, requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: responseBody.toString("base64")
    }, options);
  } catch (error) {
    await finishWebguiRequest(config, requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      bodyBase64: Buffer.from(error instanceof Error ? error.message : String(error), "utf8").toString("base64"),
      error: error instanceof Error ? error.message : String(error)
    }, options);
  }
}

async function claimWebguiRequests(
  config: RabiLinkRelayRuntimeConfig,
  waitMs: number,
  signal: AbortSignal
): Promise<RelayWebguiRequest[]> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.deviceId,
    deviceGuid: config.deviceGuid,
    deviceName: config.deviceName,
    waitMs: String(waitMs)
  });
  const body = await relayJson(config, `/worker/webgui-requests?${params}`, {
    method: "GET",
    headers: relayHeaders(config),
    signal
  });
  return webguiRequests(body);
}

function normalizeConfig(config: RabiLinkRelayRuntimeConfig): RabiLinkRelayRuntimeConfig {
  return {
    ...config,
    url: normalizeBaseUrl(config.url),
    token: config.token.trim(),
    deviceId: config.deviceId.trim(),
    deviceGuid: config.deviceGuid.trim(),
    deviceName: config.deviceName.trim(),
    claimWaitMs: Math.max(0, Math.min(60000, Number(config.claimWaitMs) || 0)),
    localWebguiUrl: normalizeBaseUrl(config.localWebguiUrl)
  };
}

export class RabiLinkRelayRuntime {
  private signature = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private runtimeStatus: RabiLinkRelayRuntimeStatus = {
    state: "disabled",
    message: "RabiLink Relay 全局连接已关闭。"
  };
  private readonly options: Required<RabiLinkRelayRuntimeOptions>;

  constructor(options: RabiLinkRelayRuntimeOptions = {}) {
    this.options = {
      localRequestTimeoutMs: Math.max(100, Number(options.localRequestTimeoutMs) || DEFAULT_LOCAL_REQUEST_TIMEOUT_MS),
      localRequestAttempts: Math.max(1, Math.min(5, Number(options.localRequestAttempts) || DEFAULT_LOCAL_REQUEST_ATTEMPTS)),
      relayWriteTimeoutMs: Math.max(100, Number(options.relayWriteTimeoutMs) || DEFAULT_RELAY_WRITE_TIMEOUT_MS),
      relayWriteAttempts: Math.max(1, Math.min(5, Number(options.relayWriteAttempts) || DEFAULT_RELAY_WRITE_ATTEMPTS))
    };
  }

  status(): RabiLinkRelayRuntimeStatus {
    return { ...this.runtimeStatus };
  }

  sync(input: RabiLinkRelayRuntimeConfig): void {
    const config = normalizeConfig(input);
    const signature = JSON.stringify(config);
    if (signature === this.signature) return;
    this.signature = signature;
    this.stopLoop();

    if (!config.enabled) {
      this.runtimeStatus = { state: "disabled", message: "RabiLink Relay 全局连接已关闭。" };
      return;
    }
    if (!config.url || !config.token) {
      this.runtimeStatus = { state: "incomplete", message: "开启 Relay 前需要填写服务器地址和应用 token。" };
      return;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.runtimeStatus = { state: "connecting", message: "正在连接 RabiLink Relay..." };
    void this.run(config, generation, controller.signal);
  }

  stop(): void {
    this.signature = "";
    this.stopLoop();
    this.runtimeStatus = { state: "disabled", message: "RabiLink Relay 全局连接已关闭。" };
  }

  private stopLoop(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private active(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private async run(config: RabiLinkRelayRuntimeConfig, generation: number, signal: AbortSignal): Promise<void> {
    let firstClaim = true;
    while (this.active(generation, signal)) {
      try {
        const requests = await claimWebguiRequests(config, firstClaim ? 0 : config.claimWaitMs, signal);
        firstClaim = false;
        if (!this.active(generation, signal)) return;
        const now = new Date().toISOString();
        this.runtimeStatus = {
          state: "online",
          message: "RabiLink Relay 已连接，本机已在服务器上线。",
          lastConnectedAt: this.runtimeStatus.lastConnectedAt || now,
          lastSuccessAt: now
        };
        for (const request of requests) {
          await proxyWebguiRequest(config, request, this.options);
        }
      } catch (error) {
        if (signal.aborted || abortError(error) || !this.active(generation, signal)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.runtimeStatus = {
          state: "error",
          message: `RabiLink Relay 连接失败：${message}`,
          lastConnectedAt: this.runtimeStatus.lastConnectedAt,
          lastSuccessAt: this.runtimeStatus.lastSuccessAt,
          error: message
        };
        await delay(RETRY_DELAY_MS, signal);
      }
    }
  }
}
