export const WEBGUI_TOKEN_QUERY_KEY = "webgui_token";

export type WebguiTokenCapture = {
  token: string;
  sanitizedHref: string;
};

export function captureWebguiTokenFromHref(href: string): WebguiTokenCapture {
  const url = new URL(href);
  let token = url.searchParams.get(WEBGUI_TOKEN_QUERY_KEY)?.trim() || "";
  let changed = url.searchParams.has(WEBGUI_TOKEN_QUERY_KEY);
  url.searchParams.delete(WEBGUI_TOKEN_QUERY_KEY);

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) {
    const hashPath = hash.slice(0, queryIndex);
    const hashQuery = new URLSearchParams(hash.slice(queryIndex + 1));
    const hashToken = hashQuery.get(WEBGUI_TOKEN_QUERY_KEY)?.trim() || "";
    if (hashToken) token = hashToken;
    if (hashQuery.has(WEBGUI_TOKEN_QUERY_KEY)) {
      changed = true;
      hashQuery.delete(WEBGUI_TOKEN_QUERY_KEY);
      const nextQuery = hashQuery.toString();
      url.hash = `#${hashPath}${nextQuery ? `?${nextQuery}` : ""}`;
    }
  }

  return {
    token,
    sanitizedHref: changed ? url.toString() : href
  };
}

export function appendWebguiTokenQuery(value: string, token: string, baseHref: string): string {
  if (!token) return value;
  const url = new URL(value, baseHref);
  url.searchParams.set(WEBGUI_TOKEN_QUERY_KEY, token);
  return url.toString();
}
