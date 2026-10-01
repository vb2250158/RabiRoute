/** A restricted persona service reuses peer transport without granting Manager administration. */
export const PERSONA_PEER_SERVICE = "persona";
export const PERSONA_REFERENCE_CAPABILITY = "persona-reference-v1";
export const PERSONA_BOOTSTRAP_DOMAIN = "rabi-persona-bootstrap-v1";

export type PersonaPeerRequest = { method: string; path: string; upgrade?: boolean; redirect?: boolean };

/** This policy is fixed by the application, never loaded from a peer or tunnel.json. */
export function personaPeerRequestAllowed(request: PersonaPeerRequest): boolean {
  if (request.upgrade || request.redirect || typeof request.path !== "string" || request.path.length > 8192
    || !request.path.startsWith("/") || request.path.startsWith("//") || /[\\#\r\n\0]/.test(request.path)) return false;
  let pathname: string;
  try {
    const rawPath = request.path.split("?", 1)[0];
    const segments = rawPath.split("/").map(segment => decodeURIComponent(segment));
    if (segments.some(segment => segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return false;
    pathname = segments.join("/");
  } catch { return false; }
  if (request.method === "POST") return /^\/api\/roles\/[^/]+\/persona-reference\/language-style$/.test(pathname);
  if (request.method !== "GET") return false;
  if (["/meta", "/api/personas", "/api/agent/help"].includes(pathname)) return true;
  return /^\/api\/roles\/[^/]+\/(?:persona-reference|knowledge\/search|plans(?:\/[^/]+)?|memory(?:\/(?:recent|consolidated)\/[^/]+)?|skills(?:\/[^/]+)?)$/.test(pathname);
}
