import type { IncomingMessage } from "node:http";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";

/** Revalidate remote admission before connection or safe local-origin access; denial never falls back. */
export function localModelSettingsRequestAllowed(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  try {
    if (assertTrustedLanAgentPrincipal(request as IncomingMessage)) return true;
    if (hasAuthenticatedConnectionRequest(request)) return true;
  } catch { return false; }
  const loopback = (host: string) => ["127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(host.toLowerCase());
  if (!loopback(request.socket.remoteAddress || "")) return false;
  if (request.headers["x-forwarded-for"] || request.headers.forwarded) return false;
  const host = request.headers.host;
  if (!host) return false;
  try {
    const localUrl = new URL(`http://${host}`);
    if (!loopback(localUrl.hostname) && localUrl.hostname !== "localhost") return false;
    const origin = request.headers.origin;
    if (origin && (typeof origin !== "string" || new URL(origin).origin !== localUrl.origin)) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    return true;
  } catch { return false; }
}
