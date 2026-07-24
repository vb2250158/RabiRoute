import http from "node:http";
import type {
  PersonaSyncConflictResolutionCommand,
  PersonaSyncMergeCommand,
  PersonaSyncService
} from "../personaSync.js";
import type { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import type { PersonaSyncAutoReconciler } from "../personaSyncAutoReconciler.js";

function jsonResponse(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", chunk => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > 24 * 1024 * 1024) {
        reject(new Error("Persona sync request is too large."));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function loopback(request: http.IncomingMessage): boolean {
  const address = String(request.socket.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export type PersonaSyncRouteContext = {
  service: PersonaSyncService;
  coordinator: PersonaSyncCoordinator;
  autoReconciler?: PersonaSyncAutoReconciler;
  token(): string;
  relay(): { url: string; token: string; deviceId: string; deviceGuid: string };
};

function authorized(request: http.IncomingMessage, ctx: PersonaSyncRouteContext): boolean {
  if (loopback(request)) return true;
  const expected = ctx.token().trim();
  if (!expected) return false;
  const header = String(request.headers["x-rabilink-token"] || "").trim();
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  return header === expected || bearer === expected;
}

export function handlePersonaSyncApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  ctx: PersonaSyncRouteContext
): boolean {
  if (!requestUrl.pathname.startsWith("/api/persona-sync")) return false;
  if (!authorized(request, ctx)) {
    jsonResponse(response, 401, { code: -1, message: "Persona sync requires the same RabiLink application token." });
    return true;
  }
  if (new Set(["/api/persona-sync/index-status", "/api/persona-sync/auto-status"]).has(requestUrl.pathname) && !loopback(request)) {
    jsonResponse(response, 403, { code: -1, message: "Persona sync diagnostics are loopback-only." });
    return true;
  }
  if (requestUrl.pathname.startsWith("/api/persona-sync/conflicts") && !loopback(request)) {
    jsonResponse(response, 403, { code: -1, message: "Persona sync conflict control is loopback-only." });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/index-status") {
    jsonResponse(response, 200, { code: 0, data: ctx.service.manifestIndexStatus() });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/auto-status") {
    jsonResponse(response, 200, {
      code: 0,
      data: ctx.autoReconciler?.status() || {
        state: "stopped",
        relayOnline: false,
        pending: false,
        pendingFullSync: false,
        pendingRoleCount: 0,
        retryAttempt: 0
      }
    });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/conflicts") {
    try {
      jsonResponse(response, 200, {
        code: 0,
        data: { conflicts: ctx.service.listConflicts(requestUrl.searchParams.get("roleId") || undefined) }
      });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/conflicts/content") {
    try {
      const result = ctx.service.readConflict(requestUrl.searchParams.get("conflictId") || "");
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(result.content.byteLength),
        "x-rabi-conflict-id": encodeURIComponent(result.conflict.conflictId),
        "x-rabi-role-id": result.conflict.roleId,
        "x-rabi-relative-path": encodeURIComponent(result.conflict.path),
        "x-rabi-local-sha256": result.conflict.localHash || "",
        "x-rabi-remote-sha256": result.conflict.remoteHash,
        "cache-control": "no-store"
      });
      response.end(result.content);
    } catch (error) {
      jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/conflicts/resolve") {
    void readJsonBody<PersonaSyncConflictResolutionCommand>(request)
      .then(async command => {
        const resolution = ctx.service.resolveConflict(command);
        const publish = await ctx.coordinator.publishConflictResolution(resolution);
        return { ...resolution, publish };
      })
      .then(result => jsonResponse(response, 200, { code: 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/peers") {
    void ctx.coordinator.peers()
      .then(peers => jsonResponse(response, 200, { code: 0, data: { peers } }))
      .catch(error => jsonResponse(response, 502, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/sync") {
    void readJsonBody<{ peerId?: string; roleId?: string }>(request)
      .then(body => {
        const peerId = String(body.peerId || "").trim();
        if (!peerId) throw new Error("Persona sync peerId is required.");
        return ctx.coordinator.sync(peerId, String(body.roleId || "").trim() || undefined);
      })
      .then(result => jsonResponse(response, result.conflicts ? 409 : 200, { code: result.conflicts ? 1 : 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/persona-sync/manifest") {
    void ctx.service.manifest(requestUrl.searchParams.get("roleId") || undefined)
      .then(manifest => jsonResponse(response, 200, { code: 0, data: manifest }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  const fileMatch = requestUrl.pathname.match(/^\/api\/persona-sync\/files\/([^/]+)\/(.+)$/);
  if (request.method === "GET" && fileMatch) {
    try {
      const result = ctx.service.readFile(decodeURIComponent(fileMatch[1]), decodeURIComponent(fileMatch[2]));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(result.content.byteLength),
        "x-rabi-role-id": result.file.roleId,
        "x-rabi-relative-path": encodeURIComponent(result.file.path),
        "x-rabi-sha256": result.file.sha256,
        "cache-control": "no-store"
      });
      response.end(result.content);
    } catch (error) {
      jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/persona-sync/merge") {
    void readJsonBody<PersonaSyncMergeCommand>(request)
      .then(command => ctx.service.merge(command))
      .then(result => jsonResponse(response, result.status === "conflict" ? 409 : 200, { code: result.status === "conflict" ? 1 : 0, data: result }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}
