import type http from "node:http";
import { RECORDING_ARCHIVE_MAX_MANIFEST_BYTES, type RecordingArchiveStore } from "./recordingArchiveStore.js";
import type { ApiOperationResult } from "./apiOperationContract.js";
import { RESOURCE_OBJECT_MAX_BYTES, resourceOwnerId } from "./resourceCacheProtocol.js";
import { resourceRequestGuard, resourceRequestJson, resourceRequestBytes, type ResourceApiInput } from "./resourceApiRequest.js";

export const RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES = RECORDING_ARCHIVE_MAX_MANIFEST_BYTES;
export interface RecordingArchiveRouteOptions {
  store: Pick<RecordingArchiveStore, "capabilities" | "putObject" | "readObject" | "commitManifest" | "readReceipt" | "getManifest">;
  /** Resolve the owner from public connection admission or the existing authenticated device resources transport, never from a bare header. */
  authorize(request: http.IncomingMessage): string | null | Promise<string | null>;
  readOnly(): boolean;
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof HttpFailure) return error;
  if ((error as { status?: number })?.status === 403) return { status: 403, code: "archive_access_denied" };
  if ((error as { status?: number })?.status === 413) return { status: 413, code: "archive_request_too_large" };
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
/** Owns archive object, manifest and receipt execution; the registrar owns HTTP dispatch. */
export async function runRecordingArchiveOperation(options: RecordingArchiveRouteOptions, input: ResourceApiInput): Promise<ApiOperationResult> {
    const { request } = input; const key = input.route.key;
    let guard = () => {};
    const headers: Record<string, string> = { "cache-control": "no-store" };
    const json = (status: number, body: unknown): ApiOperationResult => ({ status, headers, body });
    try {
      guard = resourceRequestGuard(request);
      const owner = resourceOwnerId(await options.authorize(request));
      guard();
      if (!owner) throw new HttpFailure(403, "archive_access_denied");
      const object = input.route.family === "object";
      const allowed = object ? ["GET", "PUT"] : [key === "archive.manifest.commit" ? "PUT" : "GET"];
      if (!allowed.includes(request.method ?? "")) {
        headers.allow = allowed.join(", "); throw new HttpFailure(405, "archive_method_not_allowed");
      }
      if (request.method !== "GET" && options.readOnly()) throw new HttpFailure(403, "archive_read_only");
      // Namespace unavailability is 503 even when the underlying missing-root error is ENOENT.
      let capabilities: Awaited<ReturnType<RecordingArchiveRouteOptions["store"]["capabilities"]>>;
      try { capabilities = await options.store.capabilities(owner); }
      catch { throw new HttpFailure(503, "archive_unavailable"); }
      guard();
      if (key === "archive.capabilities") {
        return json(200, { ...capabilities, maxManifestBytes: RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES });
      }
      if (object) {
        if (request.method === "GET") {
          const bytes = await options.store.readObject(owner, input.path.objectHash!); guard();
          return { status: 200, headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes };
        }
        const bytes = await resourceRequestBytes(input, RESOURCE_OBJECT_MAX_BYTES); guard();
        const result = await options.store.putObject(owner, input.path.objectHash!, bytes, guard); guard(); return json(200, result);
      }
      if (key === "archive.receipt.read") { const value = await options.store.readReceipt(owner, input.path.recordId!, input.path.manifestHash!); guard(); return json(200, value); }
      if (key === "archive.manifest.read") { const value = await options.store.getManifest(owner, input.path.recordId!); guard(); return json(200, value); }
      let value: unknown;
      try { value = await resourceRequestJson(input, RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES, true); }
      catch (error) { if (error instanceof HttpFailure || (error as { status?: number })?.status === 413) throw error; throw new HttpFailure(400, "invalid_archive_request"); }
      guard(); const result = await options.store.commitManifest(owner, input.path.recordId!, input.path.manifestHash!, value, guard); guard(); return json(200, result);
    } catch (error) {
      try { guard(); } catch (revoked) { error = revoked; }
      const result = failure(error); return json(result.status, { code: result.code });
    }
}
