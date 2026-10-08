import type { IncomingMessage } from "node:http";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

/** Reuse verified connection identity; unauthenticated local pages still require a safe origin. */
export function localModelSettingsRequestAllowed(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  if (hasAuthenticatedConnectionRequest(request)) return true;
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
