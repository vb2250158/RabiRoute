import { apiRequestHeaderAllowed } from "../../packages/rabi-api-contract/request.mjs";
import http from "node:http";
import https from "node:https";
import { Duplex, Transform, Writable, pipeline } from "node:stream";
import type { TunnelSession, TunnelStream, TunnelRequest } from "./session.js";

export type TunnelService = {
  baseUrl: string; pathPrefix?: string; headers?: Record<string, string>;
  internalHeaders?(method: string, target: string): Record<string, string>;
  requestAllowed?(request: Pick<TunnelRequest, "method" | "path" | "upgrade"> & { redirect?: boolean }): boolean;
};
export function tunnelHeaders(headers: Record<string, unknown>, response = false): Record<string, string | string[]> {
  const connection = String(headers.connection || "").toLowerCase().split(",").map(value => value.trim());
  const excluded = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie", "origin", "referer", "authorization", "content-length", ...connection]);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!excluded.has(key) && apiRequestHeaderAllowed(key) && (typeof value === "string" && !/[\r\n\0]/.test(value) || Array.isArray(value) && value.every(item => typeof item === "string" && !/[\r\n\0]/.test(item)))) result[key] = value as string | string[];
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
    ) throw new Error("Tunnel path denied.");
  return url;
}
/** Explicit nested Manager forwarding is finite; private connection protocols are not data APIs. */
function assertPeerForwardingPath(pathname: string, receiverDeviceId: string): void {
  let remaining = pathname.split("?")[0];
  for (let depth = 0; depth < 8; depth++) {
    const decoded = decodeURIComponent(remaining);
    if (decoded === remaining) break;
    remaining = decoded;
    if (depth === 7) throw new Error("Peer forwarding path too deeply encoded.");
  }
  const visited = new Set([receiverDeviceId]);
  let hops = 0;
  while (true) {
    if (["/api/rabilink/peer/tunnel/socket", "/api/rabilink/peer/receive"].includes(remaining)) throw new Error("Private peer connection protocol.");
    const nested = remaining.match(/^\/api\/rabilink\/peer\/http\/([^/]+)\/([^/]+)(\/.*)$/);
    if (!nested) return;
    if (++hops > 4 || visited.has(nested[1])) throw new Error("Peer forwarding loop or hop limit.");
    visited.add(nested[1]); remaining = nested[3];
  }
}
export function serveTunnel(session: TunnelSession, services: () => Record<string, TunnelService>, authorize: (service: string) => boolean = service => session.grant.services.includes(service)) {
  session.on("request", (stream: TunnelStream, request: TunnelRequest) => {
    let upstream: http.ClientRequest | undefined;
    const guards: Transform[] = [];
    const assertAuthorized = () => {
      if (!authorize(request.service)) throw new Error("Tunnel service authorization expired.");
    };
    const fail = () => stream.destroy(new Error("Target service connection interrupted; request result may be unknown."));
    const guard = () => {
      const checked = new Transform({
        transform(chunk, _encoding, callback) {
          try { assertAuthorized(); callback(null, chunk); } catch (error) { callback(error as Error); }
        },
        flush(callback) { try { assertAuthorized(); callback(); } catch (error) { callback(error as Error); } }
      });
      checked.on("error", fail); guards.push(checked); return checked;
    };
    const reply = (head: Parameters<TunnelStream["reply"]>[0], consume: () => void) => {
      try { assertAuthorized(); }
      catch { fail(); return; }
      void stream.reply(head).then(() => { assertAuthorized(); consume(); }).catch(fail);
    };
    stream.once("close", () => { upstream?.destroy(); for (const checked of guards) checked.destroy(); });
    try {
      if (!request || typeof request.service !== "string" || !/^[A-Z]{1,20}$/.test(request.method) || ["CONNECT", "TRACE"].includes(request.method)) throw new Error("Service denied.");
      assertAuthorized();
      const service = services()[request.service];
      if (!service) throw new Error("Service unavailable.");
      if (service.requestAllowed && !service.requestAllowed(request)) throw new Error("Service request denied.");
      const endpoint = serviceEndpoint(service, request.path);
      assertPeerForwardingPath(endpoint.pathname, session.remote.target);
      if (service.requestAllowed && !service.requestAllowed({ ...request, path: endpoint.pathname + endpoint.search })) throw new Error("Service endpoint denied.");
      // Remote headers cannot create a local identity; application-owned headers are added last.
      const headers: Record<string, string | string[]> = { ...tunnelHeaders(request.headers || {}), ...service.headers, "x-rabiroute-peer-proxy": "1",
        ...(typeof service.internalHeaders === "function" ? service.internalHeaders(request.method, endpoint.pathname + endpoint.search) : {}) };
      if (request.upgrade) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
      upstream = (endpoint.protocol === "https:" ? https : http).request(endpoint, { method: request.method, headers }, response => {
        const responseHeaders = tunnelHeaders(response.headers, true);
        if (responseHeaders.location) {
          let location: URL | undefined;
          try { location = new URL(String(responseHeaders.location), endpoint); } catch { /* Invalid redirects are denied. */ }
          if (!location || location.origin !== endpoint.origin || service.requestAllowed && !service.requestAllowed({ ...request, path: location.pathname + location.search, redirect: true })) {
            response.destroy(); reply({ status: 403, headers: { "content-type": "text/plain" } }, () => stream.end("Service redirect denied.")); return;
          }
          responseHeaders.location = location.pathname + location.search;
        }
        reply({ status: response.statusCode || 502, headers: responseHeaders }, () => pipeline(response, guard(), stream, () => {}));
      });
      upstream.once("upgrade", (response, socket, head) => {
        if (service.requestAllowed && !service.requestAllowed({ ...request, upgrade: true })) {
          socket.destroy(); reply({ status: 403, headers: { "content-type": "text/plain" } }, () => stream.end("Service upgrade denied.")); return;
        }
        // Own the upgraded socket before awaiting the reply, including cancellation during headers.
        stream.once("close", () => socket.destroy()); socket.once("error", fail);
        reply({ status: 101, headers: tunnelHeaders(response.headers, true) }, () => {
          if (head.length) stream.write(head);
          stream.pipe(guard()).pipe(socket); socket.pipe(guard()).pipe(stream);
        });
      });
      upstream.once("error", fail);
      // A WebSocket GET finishes HTTP headers but leaves the tunnel byte stream open.
      if (request.upgrade) upstream.end(); else stream.pipe(guard()).pipe(upstream);
    } catch {
      upstream?.destroy();
      void stream.reply({ status: 403, headers: { "content-type": "text/plain" } }).then(() => stream.end("Target service unavailable or access denied.")).catch(fail);
      stream.resume();
    }
  });
}
export async function proxyTunnel(session: TunnelSession, service: string, pathname: string, request: http.IncomingMessage, response: http.ServerResponse, authorize?: () => void) {
  authorize?.();
  const stream = session.open({ service, path: pathname, method: request.method || "GET", headers: tunnelHeaders(request.headers) });
  const cancel = () => { if (!response.writableFinished) stream.destroy(); };
  const requestError = (error: Error) => stream.destroy(error);
  response.once("close", cancel); request.once("aborted", cancel); request.once("error", requestError);
  const timer = setTimeout(() => stream.destroy(new Error("Tunnel response headers timed out.")), 190_000);
  const input = new Writable({
    write(chunk, encoding, done) {
      try { authorize?.(); stream.write(chunk, encoding, done); }
      catch (error) { done(error as Error); }
    },
    final(done) { try { authorize?.(); stream.end(done); } catch (error) { done(error as Error); } }
  });
  // An input denial must abort the pending header wait, not leave an unhandled sink error.
  input.on("error", error => stream.destroy(error));
  try {
    authorize?.();
    request.pipe(input);
    const head = await stream.response; clearTimeout(timer);
    authorize?.();
    // Keep redirects in the same selected target scope.
    const location = head.headers.location;
    if (typeof location === "string") head.headers.location = "/api/rabilink/peer/http/" + encodeURIComponent(session.remote.deviceId) + "/" + encodeURIComponent(service) + location;
    response.writeHead(head.status, head.headers);
    const output = new Writable({
      write(chunk, encoding, done) {
        try { authorize?.(); response.write(chunk, encoding, done); }
        catch (error) { done(error as Error); }
      },
      final(done) { try { authorize?.(); response.end(done); } catch (error) { done(error as Error); } }
    });
    await new Promise<void>((resolve, reject) => pipeline(stream, output, error => error ? reject(error) : resolve()));
  } catch (error) {
    stream.destroy();
    if (response.headersSent) { response.destroy(); throw error; }
    // Propagate original authority denial to the caller's sanitized JSON boundary.
    authorize?.();
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("Remote connection interrupted; request result may be unknown.");
  } finally {
    clearTimeout(timer);
    request.unpipe(input);
    input.destroy();
    response.off("close", cancel); request.off("aborted", cancel); request.off("error", requestError);
  }
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

export async function proxyTunnelUpgrade(session: TunnelSession, service: string, pathname: string, request: http.IncomingMessage, socket: Duplex, initial: Buffer, authorize?: () => void) {
  try { authorize?.(); } catch { socket.destroy(); return; }
  const stream = session.open({ service, path: pathname, method: "GET", headers: tunnelHeaders(request.headers), upgrade: true });
  const timer = setTimeout(() => stream.destroy(new Error("WebSocket upgrade timed out.")), 10_000);
  const guards: Transform[] = [];
  const guard = () => {
    const checked = new Transform({
      transform(chunk, _encoding, callback) { try { authorize?.(); callback(null, chunk); } catch (error) { callback(error as Error); } },
      flush(callback) { try { authorize?.(); callback(); } catch (error) { callback(error as Error); } }
    });
    checked.on("error", () => { stream.destroy(); socket.destroy(); }); guards.push(checked); return checked;
  };
  socket.once("close", () => stream.destroy()); socket.once("error", () => stream.destroy());
  stream.once("close", () => { socket.destroy(); for (const checked of guards) checked.destroy(); });
  try {
    const head = await stream.response;
    authorize?.();
    if (head.status !== 101) throw new Error("Remote WebSocket rejected.");
    const headers = { ...tunnelHeaders(head.headers, true), connection: "Upgrade", upgrade: "websocket" };
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => key + ": " + item + "\r\n")).join("") + "\r\n");
    if (initial.length) { authorize?.(); stream.write(initial); }
    socket.pipe(guard()).pipe(stream); stream.pipe(guard()).pipe(socket);
    stream.once("error", () => socket.destroy());
  } catch { stream.destroy(); socket.destroy(); }
  finally { clearTimeout(timer); }
}
