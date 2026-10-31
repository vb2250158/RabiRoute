/** Persona references use the same authenticated Manager service as other peer calls. */
export const PERSONA_PEER_SERVICE = "persona";
export const PERSONA_REFERENCE_CAPABILITY = "persona-reference-v1";

export type PersonaPeerRequest = { method: string; path: string; upgrade?: boolean; redirect?: boolean };

/** Validate transport path syntax; business operations belong to the target Manager. */
export function personaPeerRequestAllowed(request: PersonaPeerRequest): boolean {
  if (typeof request.path !== "string" || request.path.length > 8192
    || !request.path.startsWith("/") || request.path.startsWith("//") || /[\\#\r\n\0]/.test(request.path)) return false;
  try {
    const rawPath = request.path.split("?", 1)[0];
    const segments = rawPath.split("/").map(segment => decodeURIComponent(segment));
    if (segments.some(segment => segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return false;
  } catch { return false; }
  return true;
}
