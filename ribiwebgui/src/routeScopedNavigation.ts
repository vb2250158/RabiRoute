export type RouteScopedPage = "overview" | "knowledge";

export function routeScopedPagePath(routeKey: string, page: RouteScopedPage): string {
  const normalized = routeKey.trim();
  return normalized ? `/routes/${encodeURIComponent(normalized)}/${page}` : `/${page}`;
}

export function routeScopedOverviewPath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "overview");
}

export function routeScopedKnowledgePath(routeKey: string): string {
  return routeScopedPagePath(routeKey, "knowledge");
}

export function routeKeyFromWebguiHash(hash: string): string {
  const match = hash.match(/^#\/(?:routes|persona)\/([^/?#]+)(?:\/(?:overview|knowledge))?(?:[/?#]|$)/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function routeScopedPageUrl(baseUrl: string, routeKey: string, page: RouteScopedPage): string {
  const normalized = routeKey.trim();
  if (!baseUrl || !normalized) return baseUrl;
  const url = new URL(baseUrl);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const queryIndex = hash.indexOf("?");
  const hashQuery = queryIndex >= 0 ? hash.slice(queryIndex + 1) : "";
  url.hash = `#${routeScopedPagePath(normalized, page)}${hashQuery ? `?${hashQuery}` : ""}`;
  return url.toString();
}

export function routeScopedOverviewUrl(baseUrl: string, routeKey: string): string {
  return routeScopedPageUrl(baseUrl, routeKey, "overview");
}

export function routeScopedKnowledgeUrl(baseUrl: string, routeKey: string): string {
  return routeScopedPageUrl(baseUrl, routeKey, "knowledge");
}
