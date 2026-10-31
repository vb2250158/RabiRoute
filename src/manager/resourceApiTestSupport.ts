import type http from "node:http";
import type { ApiOperationResult } from "./apiOperationContract.js";
import { runResourceCacheOperation, type ResourceCache, type ResourceCacheOptions } from "./resourceCache.js";
import { runRecordingArchiveOperation, type RecordingArchiveRouteOptions } from "./recordingArchiveRoutes.js";
import { runRecordingArchiveAdminOperation, type RecordingArchiveAdminOptions } from "./recordingArchiveAdminOperation.js";
import type { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { selectResourceApiTarget } from "./resourceApiContract.js";
import { readResourceBytes } from "./resourceApiRequest.js";

/** Low-level owner tests use these adapters; production registers executable operations only. */
function write(request: http.IncomingMessage, response: http.ServerResponse, result: ApiOperationResult): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const binary = Buffer.isBuffer(result.body) || result.body instanceof Uint8Array;
  response.writeHead(result.status, { "content-type": binary ? "application/octet-stream" : "application/json; charset=utf-8", ...result.headers });
  response.end(result.body === undefined ? undefined : binary ? result.body : JSON.stringify(result.body));
  request.resume();
}
export function resourceCacheFixtureHandler(store: ResourceCache, options: ResourceCacheOptions) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    if (!url.pathname.startsWith("/api/resource-cache/")) return false;
    const target = selectResourceApiTarget(url, request.method);
    if (!target || target.route.family !== "cache" && target.route.family !== "object") { write(request, response, { status: 404, body: { message: "Not found" } }); return true; }
    void runResourceCacheOperation(store, options, { ...target, request, url }).then(result => write(request, response, result));
    return true;
  };
}
export function recordingArchiveFixtureHandler(options: RecordingArchiveRouteOptions, includeObjects = false) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    const target = selectResourceApiTarget(url, request.method);
    if (!target || target.route.family === "object" && !includeObjects || !["archive.capabilities", "archive.manifest.read", "archive.manifest.commit", "archive.receipt.read", "object.read", "object.write"].includes(target.route.key)) return false;
    void runRecordingArchiveOperation(options, { ...target, request, url, readBytes: limit => readResourceBytes(request.iterator({ destroyOnReturn: false }), limit) })
      .then(result => write(request, response, result));
    return true;
  };
}
export function recordingArchiveObjectFixtureHandler(options: RecordingArchiveRouteOptions) {
  const handler = recordingArchiveFixtureHandler(options, true);
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse) => selectResourceApiTarget(url)?.route.family === "object" && handler(request, url, response);
}
export function recordingArchiveAdminFixtureHandler(options: RecordingArchiveAdminOptions) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    const target = selectResourceApiTarget(url, request.method); if (target?.route.family !== "admin") return false;
    void runRecordingArchiveAdminOperation(options, { ...target, request, url, readBytes: limit => readResourceBytes(request.iterator({ destroyOnReturn: false }), limit) })
      .then(result => write(request, response, result));
    return true;
  };
}
export async function handleArchiveRuntimeFixture(runtime: RecordingArchiveRuntime, request: http.IncomingMessage, url: URL, response: http.ServerResponse): Promise<boolean> {
  const target = selectResourceApiTarget(url, request.method);
  if (!target || target.route.family !== "archive" && target.route.family !== "object") return false;
  const result = await runtime.operation({ ...target, request, url });
  if (!result) return false; write(request, response, result); return true;
}
