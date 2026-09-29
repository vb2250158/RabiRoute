import type http from "node:http";
import { RECORDING_ARCHIVE_MAX_MANIFEST_BYTES, type RecordingArchiveStore } from "./recordingArchiveStore.js";

export const RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES = RECORDING_ARCHIVE_MAX_MANIFEST_BYTES;
const prefix = "/api/resource-cache/data";
const id = "([A-Za-z0-9_-]{1,128})";
const hash = "([a-f0-9]{64})";
export interface RecordingArchiveRouteOptions {
  store: Pick<RecordingArchiveStore, "capabilities" | "putObject" | "readObject" | "commitManifest" | "readReceipt" | "getManifest">;
  /** Must verify the resources tunnel key AND authenticated source; never trust a bare owner header. */
  authorize(request: http.IncomingMessage): string | null | Promise<string | null>;
  readOnly(): boolean;
}
type Route = { kind: "capabilities" } | { kind: "object"; hash: string }
  | { kind: "commit" | "receipt"; recordId: string; hash: string }
  | { kind: "manifest"; recordId: string };
/** Shared /objects path, for integration before the legacy ResourceCache object branch. */
export function recognizeRecordingArchiveObject(url: URL): string | null {
  return new RegExp(`^${prefix}/objects/${hash}$`).exec(url.pathname)?.[1] ?? null;
}
function route(url: URL, objects: boolean): Route | null {
  if (url.pathname === `${prefix}/archive-capabilities`) return { kind: "capabilities" };
  const object = objects ? recognizeRecordingArchiveObject(url) : null;
  if (object) return { kind: "object", hash: object };
  let match = new RegExp(`^${prefix}/recordings/${id}/manifests/${hash}$`).exec(url.pathname);
  if (match) return { kind: "commit", recordId: match[1], hash: match[2] };
  match = new RegExp(`^${prefix}/recordings/${id}/receipts/${hash}$`).exec(url.pathname);
  if (match) return { kind: "receipt", recordId: match[1], hash: match[2] };
  match = new RegExp(`^${prefix}/recordings/${id}/manifest$`).exec(url.pathname);
  return match ? { kind: "manifest", recordId: match[1] } : null;
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
async function body(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    request.resume(); throw new HttpFailure(413, "archive_request_too_large");
  }
  const chunks: Buffer[] = []; let size = 0;
  // Event-based consumption permits a 413 response without destroying the socket as an
  // early return from IncomingMessage's async iterator would do.
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (error: Error) => { if (!done) { done = true; reject(error); } };
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { chunks.length = 0; fail(new HttpFailure(413, "archive_request_too_large")); return; }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    request.once("aborted", () => fail(new HttpFailure(400, "archive_request_aborted")));
    request.once("error", error => fail(error));
  });
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof HttpFailure) return error;
  const e = error as NodeJS.ErrnoException;
  // The store currently exposes ordinary errors. Only explicit public contract failures
  // are mapped here; unknown storage/NAS failures are unavailable, never a false receipt.
  if (e?.code === "ENOENT") return { status: 404, code: "archive_not_found" };
  if (e?.message === "Archive record conflict" || e?.message === "Archive object conflict"
      || e?.message === "Archive receipt hash mismatch") return { status: 409, code: "archive_identity_conflict" };
  if (error instanceof TypeError || error instanceof SyntaxError || /^Invalid archive (identity|hash)$/.test(e?.message ?? "")
      || e?.message === "Archive manifest identity mismatch" || e?.message === "Archive object checksum/size mismatch")
    return { status: 400, code: "invalid_archive_request" };
  return { status: 503, code: "archive_unavailable" };
}
/** No server is started. Parent mounts this behind the existing resources authentication. */
export function recordingArchiveHandler(options: RecordingArchiveRouteOptions, includeObjects = false) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    const target = route(url, includeObjects);
    if (!target) return false; // In particular, do not pretend to implement /recordings pagination.
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      const owner = await options.authorize(request);
      if (!owner || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new HttpFailure(403, "archive_access_denied");
      const allowed = target.kind === "object" ? ["GET", "PUT"] : [target.kind === "commit" ? "PUT" : "GET"];
      if (!allowed.includes(request.method ?? "")) {
        response.setHeader("allow", allowed.join(", ")); throw new HttpFailure(405, "archive_method_not_allowed");
      }
      if (request.method !== "GET" && options.readOnly()) throw new HttpFailure(403, "archive_read_only");
      // Namespace unavailability is 503 even when the underlying missing-root error is ENOENT.
      let capabilities: Awaited<ReturnType<RecordingArchiveRouteOptions["store"]["capabilities"]>>;
      try { capabilities = await options.store.capabilities(owner); }
      catch { throw new HttpFailure(503, "archive_unavailable"); }
      if (target.kind === "capabilities") {
        json(200, { ...capabilities, maxManifestBytes: RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES }); return;
      }
      if (target.kind === "object") {
        if (request.method === "GET") {
          const bytes = await options.store.readObject(owner, target.hash);
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
          response.end(bytes);
        } else json(200, await options.store.putObject(owner, target.hash, await body(request, 1024 * 1024)));
        return;
      }
      if (target.kind === "receipt") { json(200, await options.store.readReceipt(owner, target.recordId, target.hash)); return; }
      if (target.kind === "manifest") { json(200, await options.store.getManifest(owner, target.recordId)); return; }
      const raw = await body(request, RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch { throw new HttpFailure(400, "invalid_archive_request"); }
      json(200, await options.store.commitManifest(owner, target.recordId, target.hash, value));
    })().catch(error => {
      request.resume();
      if (!response.headersSent) { const result = failure(error); json(result.status, { code: result.code }); }
      else response.destroy();
    });
    return true;
  };
}
/** Explicit opt-in preserves the existing /objects URL; no parallel archive-object protocol. */
export function recordingArchiveObjectHandler(options: RecordingArchiveRouteOptions) {
  const handle = recordingArchiveHandler(options, true);
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean =>
    recognizeRecordingArchiveObject(url) !== null && handle(request, url, response);
}
