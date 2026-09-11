import http from "node:http";
import https from "node:https";
import { Duplex, pipeline } from "node:stream";
import type { TunnelSession, TunnelStream, TunnelRequest } from "./session.js";

export type TunnelService = { baseUrl: string; pathPrefix?: string; headers?: Record<string, string> };
export function tunnelHeaders(headers: Record<string, unknown>, response = false): Record<string, string | string[]> {
  const connection = String(headers.connection || "").toLowerCase().split(",").map(value => value.trim());
  const excluded = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie", "origin", "referer", "authorization", "content-length", ...connection]);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!excluded.has(key) && !key.startsWith("x-rabilink-") && !key.startsWith("x-rabiroute-") && (typeof value === "string" || Array.isArray(value) && value.every(item => typeof item === "string"))) result[key] = value as string | string[];
  }
  return result;
}
export function serviceEndpoint(service: TunnelService, requested: string): URL {
  if (typeof requested !== "string" || requested.length > 8192 || !requested.startsWith("/") || requested.startsWith("//") || /[\\#\r\n]/.test(requested)) throw new Error("Invalid tunnel path.");
  const base = new URL(service.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid registered service.");
  const prefix = (service.pathPrefix || "").replace(/\/$/, "");
  const url = new URL(prefix + requested, base.origin);
  const decoded = decodeURIComponent(url.pathname);
  if (url.origin !== base.origin || prefix && !decoded.startsWith(prefix + "/") || /(?:^|\/)\.\.(?:\/|$)/.test(decoded)
    || decoded.startsWith("/api/rabilink/peer/")) throw new Error("Tunnel path denied.");
  return url;
}
export function serveTunnel(session: TunnelSession, services: () => Record<string, TunnelService>, authorize: (service: string) => boolean = service => session.grant.services.includes(service)) {
  session.on("request", (stream: TunnelStream, request: TunnelRequest) => {
    let upstream: http.ClientRequest | undefined;
    try {
      if (!request || typeof request.service !== "string" || !authorize(request.service) || !/^[A-Z]{1,20}$/.test(request.method) || ["CONNECT", "TRACE"].includes(request.method)) throw new Error("Service denied.");
      const service = services()[request.service];
      if (!service) throw new Error("Service unavailable.");
      const endpoint = serviceEndpoint(service, request.path);
      const headers = { ...tunnelHeaders(request.headers || {}), ...service.headers };
      if (request.upgrade) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
      upstream = (endpoint.protocol === "https:" ? https : http).request(endpoint, { method: request.method, headers }, response => {
        const responseHeaders = tunnelHeaders(response.headers, true);
        if (responseHeaders.location) {
          const location = new URL(String(responseHeaders.location), endpoint);
          if (location.origin !== endpoint.origin) { response.destroy(); stream.destroy(new Error("External redirect denied.")); return; }
          responseHeaders.location = location.pathname + location.search;
        }
        void stream.reply({ status: response.statusCode || 502, headers: responseHeaders }).then(() => pipeline(response, stream, () => {}));
      });
      upstream.once("upgrade", (response, socket, head) => {
        void stream.reply({ status: 101, headers: tunnelHeaders(response.headers, true) }).then(() => {
          if (head.length) stream.write(head);
          stream.pipe(socket); socket.pipe(stream);
          socket.once("error", error => stream.destroy(error)); stream.once("close", () => socket.destroy());
        });
      });
      upstream.once("error", () => stream.destroy(new Error("Target service request failed.")));
      stream.once("close", () => upstream?.destroy());
      // A WebSocket GET finishes HTTP headers but leaves the tunnel byte stream open.
      if (request.upgrade) upstream.end(); else stream.pipe(upstream);
    } catch { upstream?.destroy(); void stream.reply({ status: 403, headers: { "content-type": "text/plain" } }).then(() => stream.end("Target service unavailable or access denied.")); stream.resume(); }
  });
}
export async function proxyTunnel(session: TunnelSession, service: string, pathname: string, request: http.IncomingMessage, response: http.ServerResponse) {
  const stream = session.open({ service, path: pathname, method: request.method || "GET", headers: tunnelHeaders(request.headers) });
  const cancel = () => { if (!response.writableFinished) stream.destroy(); };
  response.once("close", cancel); request.once("aborted", cancel);
  const timer = setTimeout(() => stream.destroy(new Error("Tunnel response headers timed out.")), 190_000);
  try {
    request.pipe(stream);
    const head = await stream.response; clearTimeout(timer);
    // Keep redirects in the same selected target scope.
    const location = head.headers.location;
    if (typeof location === "string") head.headers.location = "/api/rabilink/peer/http/" + encodeURIComponent(session.remote.deviceId) + "/" + encodeURIComponent(service) + location;
    response.writeHead(head.status, head.headers); pipeline(stream, response, () => {});
  } catch { if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" }); response.end("Remote connection interrupted; request result may be unknown."); }
  finally { clearTimeout(timer); }
}
export async function tunnelFetch(session: TunnelSession, service: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request("http://tunnel.local" + pathname, init);
  const stream = session.open({ service, path: pathname, method: request.method, headers: Object.fromEntries(request.headers) });
  const abort = () => stream.destroy(new Error("Tunnel request cancelled."));
  if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => request.signal.removeEventListener("abort", abort));
  if (request.body) {
    const reader = request.body.getReader();
    void (async () => { try { while (!stream.destroyed) { const next = await reader.read(); if (next.done) break; await new Promise<void>((resolve, reject) => stream.write(Buffer.from(next.value), error => error ? reject(error) : resolve())); } stream.end(); }
      catch (error) { stream.destroy(error as Error); } finally { await reader.cancel().catch(() => {}); } })();
  } else stream.end();
  const head = await stream.response;
  const headers = new Headers(); for (const [name, value] of Object.entries(head.headers)) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  const body = [204, 205, 304].includes(head.status) || request.method === "HEAD" ? null : Duplex.toWeb(stream).readable as ReadableStream<Uint8Array>;
  if (!body) stream.resume();
  return new Response(body, { status: head.status, headers });
}

export async function proxyTunnelUpgrade(session: TunnelSession, service: string, pathname: string, request: http.IncomingMessage, socket: Duplex, initial: Buffer) {
  const stream = session.open({ service, path: pathname, method: "GET", headers: tunnelHeaders(request.headers), upgrade: true });
  const timer = setTimeout(() => stream.destroy(new Error("WebSocket upgrade timed out.")), 10_000);
  socket.once("close", () => stream.destroy()); socket.once("error", () => stream.destroy());
  try {
    const head = await stream.response;
    if (head.status !== 101) throw new Error("Remote WebSocket rejected.");
    const headers = { ...head.headers, connection: "Upgrade", upgrade: "websocket" };
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => key + ": " + item + "\r\n")).join("") + "\r\n");
    if (initial.length) stream.write(initial); socket.pipe(stream); stream.pipe(socket);
    stream.once("error", () => socket.destroy()); stream.once("close", () => socket.destroy());
  } catch { stream.destroy(); socket.destroy(); }
  finally { clearTimeout(timer); }
}
