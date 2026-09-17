import type http from "node:http";
import { DshConnectionStore, DshConnectionError, dshLocalOrigin } from "../dshConnectionStore.js";
import { connectDshOwner, migrateDshOwner } from "../dshHttpAuth.js";

/** Origin is mandatory: Relay strips it before forwarding to loopback. */
export function dshConnectionRequestAllowed(request: Pick<http.IncomingMessage, "headers" | "socket">, mutation: boolean): boolean {
  const loopback = (value: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1", "[::1]", "localhost"].includes(value);
  if (!loopback(request.socket.remoteAddress || "") || request.headers.forwarded || request.headers["x-forwarded-for"]
    || request.headers["sec-fetch-site"] === "cross-site") return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!loopback(host.hostname)) return false;
    const origin = request.headers.origin;
    if (mutation && typeof origin !== "string") return false;
    if (origin && (typeof origin !== "string" || new URL(origin).origin !== host.origin)) return false;
    return true;
  } catch { return false; }
}

async function readBody(request: http.IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const abort = () => request.destroy(new Error("DSH connection request cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16384) throw new DshConnectionError("DSH connection request is too large.", 413);
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body;
  } catch { throw new DshConnectionError("DSH connection request must be JSON."); }
  } finally { signal.removeEventListener("abort", abort); }
}

export async function handleDshConnectionRequest(request: http.IncomingMessage, url: URL, store = new DshConnectionStore(), serviceSignal?: AbortSignal) {
  const signal = serviceSignal ? AbortSignal.any([serviceSignal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  signal.throwIfAborted();
  const mutation = request.method !== "GET";
  if (url.pathname.endsWith("/connections") && mutation) throw new DshConnectionError("Unsupported DSH connection operation.", 405);
  if (!dshConnectionRequestAllowed(request, mutation)) throw new DshConnectionError("Open the local RabiRoute console on this computer to manage DSH authorization.", 403);
  if (mutation && !/^application\/json(?:;|$)/i.test(String(request.headers["content-type"] || ""))) throw new DshConnectionError("JSON content type is required.", 415);
  if (request.method === "GET") {
    const metadata = store.readMetadata();
    if (url.pathname.endsWith("/connections")) return { ok: true, revision: metadata.revision, endpoints: metadata.connections };
    const origin = dshLocalOrigin(url.searchParams.get("baseUrl") || "");
    return { ok: true, revision: metadata.revision, connection: metadata.connections.find(row => row.baseUrl === origin)
      || { baseUrl: origin, state: "not_connected" } };
  }
  const body = await readBody(request, signal);
  if (request.method === "POST") {
    if (Object.keys(body).some(key => !["launchUrl", "baseUrl", "expectedRevision"].includes(key))
      || ("launchUrl" in body) === ("baseUrl" in body)) throw new DshConnectionError("Provide one DSH login link or existing connection address.");
    if (!Number.isSafeInteger(body.expectedRevision)) throw new DshConnectionError("Refresh DSH connection settings before saving.");
    const connection = typeof body.baseUrl === "string"
      ? await migrateDshOwner(body.baseUrl, Number(body.expectedRevision), store, signal)
      : await connectDshOwner(body.launchUrl, Number(body.expectedRevision), store, signal);
    return { ok: true, revision: connection.revision, connection };
  }
  if (request.method === "DELETE") {
    if (typeof body.baseUrl !== "string" || !Number.isSafeInteger(body.expectedRevision)
      || Object.keys(body).some(key => !["baseUrl", "expectedRevision"].includes(key))) throw new DshConnectionError("DSH connection address and current revision are required.");
    signal.throwIfAborted();
    store.disconnect(body.baseUrl, Number(body.expectedRevision));
    return { ok: true, revision: store.readMetadata().revision };
  }
  throw new DshConnectionError("Unsupported DSH connection operation.", 405);
}
