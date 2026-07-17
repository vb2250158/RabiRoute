export type LocalSpeechResponse = {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
};

type FetchLike = typeof fetch;

const forwardedHeaderNames = [
  "content-disposition",
  "x-rabispeech-provider",
  "x-rabispeech-model",
  "x-rabispeech-playback-job"
];

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4
    && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 127;
}

/** Keep RabiPC's local control plane from turning into an arbitrary HTTP proxy. */
export function normalizeLocalSpeechServiceUrl(value: string): string {
  const parsed = new URL(String(value || "").trim());
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error("语音服务地址只支持 HTTP 或 HTTPS。");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("语音服务只允许访问本机回环地址。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("语音服务地址不能包含用户名或密码。");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function localSpeechEndpoint(configuredUrl: string, pathname: string): string {
  const baseUrl = normalizeLocalSpeechServiceUrl(configuredUrl);
  const safePath = `/${String(pathname || "").replace(/^\/+/, "")}`;
  return `${baseUrl}${safePath}`;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of forwardedHeaderNames) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export async function requestLocalSpeech(
  configuredUrl: string,
  pathname: string,
  init: RequestInit = {},
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<LocalSpeechResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 190_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(localSpeechEndpoint(configuredUrl, pathname), {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json, audio/*;q=0.9, */*;q=0.1",
        ...(init.headers ?? {})
      }
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      headers: responseHeaders(response),
      body: Buffer.from(await response.arrayBuffer())
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestLocalSpeechJson<T>(
  configuredUrl: string,
  pathname: string,
  init: RequestInit = {},
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<{ status: number; data: T }> {
  const response = await requestLocalSpeech(configuredUrl, pathname, init, options);
  const text = response.body.toString("utf8");
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`RabiSpeech returned non-JSON data (HTTP ${response.status}).`);
  }
  return { status: response.status, data: data as T };
}
