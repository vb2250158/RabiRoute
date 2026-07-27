import { WEBGUI_TOKEN_QUERY_KEY } from "./webguiAccessToken";

export type WebguiLanRedirectState = {
  enabled: boolean;
  token: string;
  listeningOnLan: boolean;
  urls: Array<{ url: string }>;
};

function isLoopbackHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return hostname === "localhost"
    || hostname === "::1"
    || hostname === "127.0.0.1"
    || hostname.startsWith("127.");
}

export function lanWebguiRedirectUrl(currentHref: string, lanBaseUrl: string, token: string): string {
  if (!lanBaseUrl || !token.trim()) return "";
  const current = new URL(currentHref);
  const target = new URL(lanBaseUrl);
  if (!isLoopbackHostname(current.hostname) || isLoopbackHostname(target.hostname)) return "";

  target.pathname = current.pathname;
  target.search = current.search;
  target.searchParams.delete(WEBGUI_TOKEN_QUERY_KEY);

  const currentHash = current.hash || target.hash || "#/overview";
  const hash = currentHash.startsWith("#") ? currentHash.slice(1) : currentHash;
  const queryIndex = hash.indexOf("?");
  const hashPath = queryIndex >= 0 ? hash.slice(0, queryIndex) : hash;
  const hashQuery = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
  hashQuery.set(WEBGUI_TOKEN_QUERY_KEY, token.trim());
  target.hash = `#${hashPath}?${hashQuery.toString()}`;
  return target.toString();
}

export function redirectCurrentWebguiToLan(state: WebguiLanRedirectState): boolean {
  if (!state.enabled || !state.listeningOnLan) return false;
  const redirectUrl = lanWebguiRedirectUrl(window.location.href, state.urls[0]?.url || "", state.token);
  if (!redirectUrl) return false;
  window.location.replace(redirectUrl);
  return true;
}

export async function redirectLoopbackWebguiToLan(): Promise<boolean> {
  if (!isLoopbackHostname(window.location.hostname)) return false;
  try {
    const response = await fetch("/api/webgui-access");
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) return false;
    return redirectCurrentWebguiToLan(body.data as WebguiLanRedirectState);
  } catch {
    return false;
  }
}
