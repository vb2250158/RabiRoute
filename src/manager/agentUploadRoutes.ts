import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentUploadStreamInput } from "./agentUploadStore.js";
import { getTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export type AgentUploadDto = { id: string; fileName: string; size: number; sha256: string; expiresAt: string };
type Owner = { nodeId: string; agentId: string };
export interface AgentUploadRouteStore {
  readonly limits: { readonly maxFileBytes: number };
  uploadStream(input: AgentUploadStreamInput): Promise<AgentUploadDto>;
  get(owner: Owner, id: string): AgentUploadDto | undefined | Promise<AgentUploadDto | undefined>;
}
export type AgentUploadRoutesContext = {
  store: AgentUploadRouteStore;
  /** Must re-read current policy; a denied or revoked principal must throw. */
  assertAuthorized: (source: TrustedLanAgentSource) => void | Promise<void>;
  maxFileBytes?: number;
  maxConcurrentReaders?: number;
  readTimeoutMs?: number;
  jsonResponse?: (response: ServerResponse, statusCode: number, body: unknown) => void;
};

class UploadHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}
function header(request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name];
  if (!values || values.length !== 1) throw new UploadHttpError(400, "invalid_input");
  return values[0];
}
function publicDto(value: AgentUploadDto): AgentUploadDto {
  return { id: value.id, fileName: value.fileName, size: value.size, sha256: value.sha256, expiresAt: value.expiresAt };
}

/** Event-based reading deliberately avoids async-iterator destruction on a 413. */
async function* readBinary(request: IncomingMessage, response: ServerResponse, limit: number, timeoutMs: number): AsyncGenerator<Buffer> {
  let failure: UploadHttpError | undefined;
  let wake: (() => void) | undefined;
  let ended = request.readableEnded;
  let pending: Buffer | undefined;
  let size = 0;
  const fail = (error: UploadHttpError) => { failure = error; request.pause(); wake?.(); };
  const data = (chunk: Buffer) => { request.pause(); pending = chunk; wake?.(); };
  const end = () => { ended = true; wake?.(); };
  const aborted = () => fail(new UploadHttpError(400, "upload_aborted"));
  const closed = () => { if (!request.complete) aborted(); };
  const timer = setTimeout(() => fail(new UploadHttpError(408, "upload_timeout")), timeoutMs); timer.unref();
  request.on("data", data); request.once("end", end); request.once("aborted", aborted); request.once("error", aborted); request.once("close", closed); response.once("close", aborted);
  if (request.aborted || response.destroyed) aborted();
  try {
    while (!ended || pending) {
      if (failure) throw failure;
      if (!pending) { await new Promise<void>(resolve => { wake = resolve; request.resume(); }); wake = undefined; continue; }
      const chunk = pending; pending = undefined; size += chunk.length;
      if (size > limit) throw new UploadHttpError(413, "file_too_large");
      yield chunk;
    }
    if (failure) throw failure;
  } finally {
    clearTimeout(timer); request.pause(); request.off("data", data); request.off("end", end); request.off("aborted", aborted); request.off("error", aborted); request.off("close", closed); response.off("close", aborted);
  }
}

export function createAgentUploadRoutes(context: AgentUploadRoutesContext): {
  handler: ManagerPluginRouteHandler;
  stopAcceptingAndDrain: () => Promise<void>;
  activeRequestCount: () => number;
} {
  const storeLimit = positiveInteger(context.store.limits.maxFileBytes, "store.limits.maxFileBytes");
  const limit = positiveInteger(context.maxFileBytes ?? storeLimit, "maxFileBytes");
  if (limit > storeLimit) throw new Error("maxFileBytes cannot exceed store.limits.maxFileBytes.");
  const concurrency = positiveInteger(context.maxConcurrentReaders ?? 4, "maxConcurrentReaders");
  const timeout = positiveInteger(context.readTimeoutMs ?? 30 * 60_000, "readTimeoutMs");
  const tracker = new ManagerPluginRequestTracker();
  const readers = new Map<string, number>();
  let totalReaders = 0;
  let accepting = true;
  const json = context.jsonResponse ?? ((response, status, body) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  });
  const authorize = async (source: TrustedLanAgentSource) => {
    try { await context.assertAuthorized(source); } catch { throw new UploadHttpError(403, "forbidden"); }
  };
  const run = async (request: IncomingMessage, url: URL, response: ServerResponse) => {
    let ownerKey: string | undefined;
    try {
      const source = getTrustedLanAgentSource(request);
      if (!source) throw new UploadHttpError(403, "forbidden");
      await authorize(source);
      if (request.method !== "GET" && request.method !== "PUT") {
        response.setHeader("Allow", "GET, PUT");
        throw new UploadHttpError(405, "method_not_allowed");
      }
      const id = url.pathname.slice("/api/agent/uploads/".length);
      if (!uuidPattern.test(id)) throw new UploadHttpError(400, "invalid_input");
      const owner = { nodeId: source.nodeId, agentId: source.agentId };
      if (request.method === "GET") {
        await authorize(source);
        const result = await context.store.get(owner, id);
        if (!result) throw new UploadHttpError(404, "not_found");
        await authorize(source);
        json(response, 200, { code: 0, data: publicDto(result) });
        return;
      }
      if (header(request, "idempotency-key") !== id) throw new UploadHttpError(400, "invalid_idempotency_key");
      response.setHeader("Idempotency-Key", id);
      if (header(request, "content-type").toLowerCase() !== "application/octet-stream") throw new UploadHttpError(415, "unsupported_media_type");
      if (request.headers["content-encoding"] !== undefined) throw new UploadHttpError(415, "unsupported_content_encoding");
      const sha256 = header(request, "x-rabiroute-content-sha256");
      if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new UploadHttpError(400, "invalid_input");
      let fileName: string;
      try { fileName = decodeURIComponent(header(request, "x-rabiroute-file-name")); } catch { throw new UploadHttpError(400, "invalid_input"); }
      if (!fileName || fileName === "." || fileName === ".." || /[\\/:\x00-\x1f\x7f]/.test(fileName)) throw new UploadHttpError(400, "invalid_input");
      if (request.headers["content-length"] !== undefined && Number(header(request, "content-length")) > limit) throw new UploadHttpError(413, "file_too_large");
      const key = JSON.stringify([owner.nodeId, owner.agentId]);
      const count = readers.get(key) ?? 0;
      if (totalReaders >= concurrency || count >= concurrency) throw new UploadHttpError(429, "upload_busy");
      totalReaders++;
      readers.set(key, count + 1);
      ownerKey = key;
      const size = request.headers["content-length"] === undefined ? undefined : Number(header(request, "content-length"));
      const result = await context.store.uploadStream({ owner, uploadId: id, fileName, content: readBinary(request, response, limit, timeout), size, sha256: sha256.toLowerCase(), beforeCommit: async () => {
        await authorize(source);
        if (request.aborted || response.destroyed) throw new UploadHttpError(400, "upload_aborted");
      } });
      if (!response.destroyed) json(response, 200, { code: 0, data: publicDto(result) });
    } catch (error) {
      const code = error instanceof UploadHttpError ? error.code : (error as { code?: string } | null)?.code;
      const statuses: Record<string, number> = { not_found: 404, invalid_input: 400, conflict: 409, capacity: 507, integrity: 422, unsafe_storage: 500, storage_failure: 500 };
      const status = error instanceof UploadHttpError ? error.status : (code && statuses[code]) || 500;
      if (!response.destroyed && !response.writableEnded) {
        // Close after the JSON response. Discard without buffering; server requestTimeout
        // remains the outer bound for an uncooperative peer. Never destroy before 413.
        if (!request.complete) { response.setHeader("Connection", "close"); request.on("error", () => undefined); request.resume(); }
        json(response, status, { code: error instanceof UploadHttpError || (code && statuses[code]) ? code : "storage_failure" });
      }
    } finally {
      if (ownerKey !== undefined) {
        totalReaders--;
        const remaining = (readers.get(ownerKey) ?? 1) - 1;
        if (remaining) readers.set(ownerKey, remaining); else readers.delete(ownerKey);
      }
    }
  };
  const tracked = tracker.wrap((request, url, response) => {
    void tracker.trackOperation(run(request, url, response)).catch(() => { if (!response.destroyed) response.destroy(); });
    return true;
  });
  return {
    handler: (request, url, response) => {
      if (!url.pathname.startsWith("/api/agent/uploads/")) return false;
      if (!accepting) { json(response, 503, { code: "upload_stopping" }); return true; }
      return tracked(request, url, response);
    },
    stopAcceptingAndDrain: () => { accepting = false; return tracker.stop(); },
    activeRequestCount: () => tracker.activeOperationCount()
  };
}
