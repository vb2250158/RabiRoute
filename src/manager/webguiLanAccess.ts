import { randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const WEBGUI_TOKEN_QUERY_KEY = "webgui_token";
export const WEBGUI_TOKEN_HEADER = "x-rabiroute-webgui-token";

export type WebguiLanAccessConfig = {
  enabled: boolean;
  accessToken: string;
};

export function defaultWebguiLanAccessConfig(): WebguiLanAccessConfig {
  return {
    enabled: false,
    accessToken: ""
  };
}

export function normalizeWebguiLanAccessConfig(raw: unknown): WebguiLanAccessConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<WebguiLanAccessConfig>
    : {};
  return {
    enabled: source.enabled === true,
    accessToken: typeof source.accessToken === "string" ? source.accessToken.trim() : ""
  };
}

export function generateWebguiAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const address = normalizedRemoteAddress(value);
  return address === "::1"
    || address === "localhost"
    || address === "127.0.0.1"
    || address.startsWith("127.");
}

function normalizedRemoteAddress(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/^::ffff:/, "");
}

export function isLocalMachineRemoteAddress(value: string | undefined, localAddresses: string[]): boolean {
  const address = normalizedRemoteAddress(value);
  return isLoopbackRemoteAddress(address)
    || localAddresses.some(localAddress => normalizedRemoteAddress(localAddress) === address);
}

export function isLoopbackBindHost(value: string | undefined): boolean {
  const host = (value || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

export function managerListensOnLan(host: string): boolean {
  return !isLoopbackBindHost(host);
}

export function lanAddressPriority(name: string, address: string): number {
  const normalizedName = name.toLowerCase();
  const virtualPenalty = /(vethernet|hyper-v|wsl|vmware|virtualbox|radmin|tailscale|zerotier|vpn|loopback)/i.test(normalizedName)
    ? 100
    : 0;
  const parts = address.split(".").map(Number);
  let rangePriority = 30;
  if (parts[0] === 192 && parts[1] === 168) rangePriority = 0;
  else if (parts[0] === 10) rangePriority = 10;
  else if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) rangePriority = 20;
  else if (parts[0] === 169 && parts[1] === 254) rangePriority = 200;
  return virtualPenalty + rangePriority;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function webguiRequestToken(request: http.IncomingMessage, requestUrl: URL): string {
  return headerValue(request.headers[WEBGUI_TOKEN_HEADER]).trim()
    || requestUrl.searchParams.get(WEBGUI_TOKEN_QUERY_KEY)?.trim()
    || "";
}

export function webguiTokenMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.byteLength === expectedBuffer.byteLength
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isPublicWebguiStaticRequest(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/"
    || pathname === "/index.html"
    || pathname === "/favicon.ico"
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/reports/");
}

export function isWebguiLanRequestAuthorized(
  request: http.IncomingMessage,
  requestUrl: URL,
  config: WebguiLanAccessConfig
): boolean {
  if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return true;
  return webguiTokenMatches(webguiRequestToken(request, requestUrl), config.accessToken);
}
