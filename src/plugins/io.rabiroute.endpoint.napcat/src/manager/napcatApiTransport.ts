import type { IncomingMessage } from "node:http";
import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "@rabiroute/host-api/manager/lanAgentBodyAuthority";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { definitionUsesNapcat, type GatewayDefinition, type NapCatInstanceDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { boundedBytes, qqRead, QqReadError } from "./qqMessageMedia.js";

export class NapcatApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export type NapcatApiTransportContext = {
  route(routeId: string): GatewayDefinition | undefined;
  local(request: IncomingMessage): boolean;
  assertCurrent?(): void;
  transport?: typeof fetch;
};

export type NapcatApiSelection = Readonly<{
  routeId: string;
  instanceId: string;
  botUserId: string;
  httpUrl: string;
  accessToken: string;
  assertCurrent(): void;
}>;

function authenticated(request: IncomingMessage, context: NapcatApiTransportContext): boolean {
  try {
    if (assertTrustedLanAgentPrincipal(request) || hasAuthenticatedConnectionRequest(request)) return true;
    if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"]
      || request.headers["x-rabiroute-peer-proxy"] || getTrustedLanAgentSource(request) || hasLanAgentBodyGuard(request)) return false;
    return context.local(request);
  } catch { return false; }
}

/** Shared existing authority guard; management bootstrap does not imply OneBot account readiness. */
export function assertNapcatApiRequestAuthority(context: NapcatApiTransportContext, request: IncomingMessage, signal?: AbortSignal): void {
  context.assertCurrent?.();
  signal?.throwIfAborted();
  if (!authenticated(request, context)) throw new NapcatApiError(403, "QQ_API_AUTH_REQUIRED");
}

/** Capture the original Route, instance and configured QQ account before any provider call. */
export function selectNapcatApiInstance(context: NapcatApiTransportContext, request: IncomingMessage,
  routeId: string, instanceId: string, signal?: AbortSignal): NapcatApiSelection {
  const authorize = () => assertNapcatApiRequestAuthority(context, request, signal);
  authorize();
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled !== true || !definitionUsesNapcat(definition)) throw new NapcatApiError(409, "QQ_API_ROUTE_UNAVAILABLE");
  const instances = definition.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
  if (instances.length !== 1) throw new NapcatApiError(409, "QQ_API_INSTANCE_UNAVAILABLE");
  const instance = instances[0]!;
  const botUserId = String(instance.botUserId ?? "");
  if (!/^[1-9]\d{0,15}$/.test(botUserId)) throw new NapcatApiError(409, "QQ_API_CONFIGURED_ACCOUNT_REQUIRED");
  let url: URL;
  try { url = new URL(instance.httpUrl); }
  catch { throw new NapcatApiError(409, "QQ_API_ENDPOINT_UNSAFE"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new NapcatApiError(409, "QQ_API_ENDPOINT_UNSAFE");
  }
  const snapshot = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "", botUserId };
  const currentInstance = (): NapCatInstanceDefinition | undefined => {
    const current = context.route(routeId);
    if (current !== definition || current.id !== routeId || current.enabled !== true || !definitionUsesNapcat(current)) return;
    const matches = current.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const assertCurrent = () => {
    authorize();
    const current = currentInstance();
    if (!current || current.httpUrl !== snapshot.httpUrl || (current.accessToken ?? "") !== snapshot.accessToken
      || String(current.botUserId ?? "") !== botUserId) throw new NapcatApiError(409, "QQ_API_BINDING_CHANGED");
  };
  return Object.freeze({ routeId, instanceId, botUserId, httpUrl: url.origin, accessToken: snapshot.accessToken, assertCurrent });
}

/** Shared by the fixed OneBot and WebUI transports; the current selected identity is never caller-supplied. */
export async function verifyNapcatApiIdentity(context: NapcatApiTransportContext, selection: NapcatApiSelection, signal: AbortSignal): Promise<Record<string, unknown>> {
  selection.assertCurrent();
  const identity = await qqRead(selection, "get_login_info", {}, signal, context.transport);
  selection.assertCurrent();
  if (String(identity.user_id ?? "") !== selection.botUserId) throw new NapcatApiError(409, "QQ_API_ACCOUNT_MISMATCH");
  return identity;
}

/** The caller supplies a registered static action. Provider errors never include raw bodies or URLs. */
export async function callNapcatApi(context: NapcatApiTransportContext, selection: NapcatApiSelection,
  action: string, parameters: unknown, registeredActions: ReadonlySet<string>, signal: AbortSignal): Promise<unknown> {
  if (!registeredActions.has(action) || !/^\.?[a-zA-Z_][a-zA-Z0-9_]*$/.test(action)) throw new NapcatApiError(404, "QQ_API_ACTION_NOT_REGISTERED");
  await verifyNapcatApiIdentity(context, selection, signal);
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(new URL(action, selection.httpUrl + "/"), {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(selection.accessToken ? { authorization: `Bearer ${selection.accessToken}` } : {}) },
      body: JSON.stringify(parameters)
    });
  } catch {
    throw new NapcatApiError(503, "QQ_API_UPSTREAM_UNAVAILABLE");
  }
  if (!response.ok) throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
  const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
  selection.assertCurrent();
  let envelope: { status?: unknown; retcode?: unknown; data?: unknown };
  try { envelope = JSON.parse(bytes.toString("utf8")); }
  catch { throw new NapcatApiError(503, "QQ_API_UPSTREAM_RESPONSE_INVALID"); }
  if (envelope?.status !== "ok" || envelope.retcode !== 0) throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
  return envelope.data;
}

type ManagedNativeAttachment = Readonly<{ path: string; sha256: string }>;
type ManagedAttachmentAction =
  | Readonly<{ action: "download_file" }>
  | Readonly<{ action: "upload_image_to_qun_album"; groupId: string; albumId: string; albumName: string }>;

async function verifyLeasedFile(file: FileHandle, expectedHash: string, expectedSize: number,
  authorize: () => void, signal: AbortSignal): Promise<void> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(65_535);
  let position = 0;
  while (true) {
    signal.throwIfAborted();
    authorize();
    const read = await file.read(buffer, 0, buffer.length, position);
    if (read.bytesRead === 0) break;
    position += read.bytesRead;
    if (position > expectedSize) throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
    hash.update(buffer.subarray(0, read.bytesRead));
  }
  signal.throwIfAborted();
  authorize();
  if (position !== expectedSize || hash.digest("hex") !== expectedHash) {
    throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
  }
}

/** Internal fixed actions only. The SDK owns this local attachment lease; no caller URL/path reaches this entry. */
export async function callNapcatManagedAttachment(context: NapcatApiTransportContext, selection: NapcatApiSelection,
  target: ManagedAttachmentAction, attachment: ManagedNativeAttachment, signal: AbortSignal): Promise<unknown> {
  let prefix: string;
  if (target.action === "download_file") {
    prefix = '{"base64":"';
  } else if (target.action === "upload_image_to_qun_album" && /^[1-9][0-9]{0,15}$/.test(target.groupId)
    && typeof target.albumId === "string" && typeof target.albumName === "string") {
    const metadata = JSON.stringify({ group_id: target.groupId, album_id: target.albumId, album_name: target.albumName });
    prefix = metadata.slice(0, -1) + ',"file":"base64://';
  } else {
    throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_ATTACHMENT_ACTION_INVALID");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(attachment.sha256)) {
    throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_ATTACHMENT_HASH_INVALID");
  }
  const expectedHash = attachment.sha256.toLowerCase();
  let file: FileHandle;
  try {
    file = await open(attachment.path, "r");
  } catch {
    throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ATTACHMENT_UNAVAILABLE");
  }
  let body: Readable | undefined;
  let bodyFinished: Promise<void> | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > qqReadSettings.mediaBytes) {
      throw new NapcatApiError(413, "QQ_NATIVE_EGRESS_ATTACHMENT_TOO_LARGE");
    }
    await verifyLeasedFile(file, expectedHash, stat.size, selection.assertCurrent, signal);
    await verifyNapcatApiIdentity(context, selection, signal);
    body = Readable.from((async function* () {
      yield prefix;
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(65_535);
      let position = 0;
      let remainder = Buffer.alloc(0);
      while (true) {
        signal.throwIfAborted();
        selection.assertCurrent();
        const read = await file.read(buffer, 0, buffer.length, position);
        if (read.bytesRead === 0) break;
        position += read.bytesRead;
        if (position > stat.size) throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        const joined = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
        const completeBytes = joined.length - joined.length % 3;
        if (completeBytes) yield joined.subarray(0, completeBytes).toString("base64");
        remainder = Buffer.from(joined.subarray(completeBytes));
      }
      signal.throwIfAborted();
      selection.assertCurrent();
      if (position !== stat.size || hash.digest("hex") !== expectedHash) {
        throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
      }
      if (remainder.length) yield remainder.toString("base64");
      yield '"}';
    })(), { objectMode: false, highWaterMark: 65_536 });
    bodyFinished = finished(body);
    // A body failure can precede fetch's rejection; keep the same promise handled until it is awaited below.
    void bodyFinished.catch(() => {});
    const abort = () => body?.destroy(signal.reason instanceof Error ? signal.reason : new Error("Native attachment upload aborted."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await (context.transport ?? fetch)(new URL(target.action, selection.httpUrl + "/"), {
        method: "POST", redirect: "error", signal, duplex: "half", body: Readable.toWeb(body, {
          strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength }
        }) as ReadableStream<Uint8Array>,
        headers: { "content-type": "application/json", ...(selection.accessToken ? { authorization: `Bearer ${selection.accessToken}` } : {}) }
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
      }
      await bodyFinished;
      selection.assertCurrent();
      const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
      let envelope: { status?: unknown; retcode?: unknown; data?: unknown };
      try {
        envelope = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new NapcatApiError(503, "QQ_API_UPSTREAM_RESPONSE_INVALID");
      }
      selection.assertCurrent();
      if (envelope.status !== "ok" || envelope.retcode !== 0) {
        throw new NapcatApiError(503, "QQ_API_UPSTREAM_REJECTED");
      }
      return envelope.data;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } catch (error) {
    if (error instanceof NapcatApiError || error instanceof QqReadError) throw error;
    throw new NapcatApiError(503, signal.aborted ? "QQ_NATIVE_EGRESS_ATTACHMENT_ABORTED" : "QQ_NATIVE_EGRESS_ATTACHMENT_TRANSFER_UNKNOWN");
  } finally {
    body?.destroy();
    await bodyFinished?.catch(() => {});
    try {
      await file.close();
    } catch {
      throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ATTACHMENT_CLOSE_FAILED");
    }
  }
}

/** Actual installed upload_file_stream protocol. Chunk acknowledgements never substitute for the final native SHA/size proof. */
export async function uploadNapcatManagedFileStream(context: NapcatApiTransportContext, selection: NapcatApiSelection,
  target: { streamId: string; chunkBytes: number; fileRetentionMs: number }, attachment: ManagedNativeAttachment,
  signal: AbortSignal): Promise<{ nativePath: string; bytes: number; sha256: string }> {
  const maxChunkBytes = Math.max(1, Math.floor((qqReadSettings.jsonBytes - 4096) * 3 / 4));
  if (!/^[a-f0-9]{64}$/.test(target.streamId) || !Number.isSafeInteger(target.chunkBytes) || target.chunkBytes < 1 || target.chunkBytes > maxChunkBytes
    || !Number.isSafeInteger(target.fileRetentionMs) || target.fileRetentionMs < 0 || !/^[a-fA-F0-9]{64}$/.test(attachment.sha256)) {
    throw new NapcatApiError(400, "QQ_NATIVE_UPLOAD_STREAM_INPUT_INVALID");
  }
  let file: FileHandle;
  try {
    file = await open(attachment.path, "r");
  } catch {
    throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ATTACHMENT_UNAVAILABLE");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > qqReadSettings.mediaBytes) {
      throw new NapcatApiError(413, "QQ_NATIVE_EGRESS_ATTACHMENT_TOO_LARGE");
    }
    // getOrCreateStream requires a truthy total_chunks; processChunk ignores empty chunk_data.
    if (stat.size === 0) throw new NapcatApiError(422, "QQ_NATIVE_EMPTY_UPLOAD_STREAM_UNSUPPORTED");
    const expectedHash = attachment.sha256.toLowerCase();
    await verifyLeasedFile(file, expectedHash, stat.size, selection.assertCurrent, signal);
    const totalChunks = Math.ceil(stat.size / target.chunkBytes);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(target.chunkBytes);
    const actions = new Set(["upload_file_stream"]);
    let position = 0;
    for (let index = 0; index < totalChunks; index++) {
      const chunkLength = Math.min(target.chunkBytes, stat.size - position);
      let offset = 0;
      while (offset < chunkLength) {
        signal.throwIfAborted(); selection.assertCurrent();
        const read = await file.read(buffer, offset, chunkLength - offset, position + offset);
        if (read.bytesRead === 0) throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
        offset += read.bytesRead;
      }
      const bytes = buffer.subarray(0, chunkLength);
      hash.update(bytes); position += bytes.length;
      const response = await callNapcatApi(context, selection, "upload_file_stream", {
        stream_id: target.streamId, file_retention: target.fileRetentionMs, chunk_data: bytes.toString("base64"),
        chunk_index: index, total_chunks: totalChunks, file_size: stat.size, expected_sha256: expectedHash,
        filename: target.streamId + ".bin"
      }, actions, signal);
      const acknowledgement = response as Record<string, unknown> | null;
      if (acknowledgement?.type !== "stream" || acknowledgement.stream_id !== target.streamId || acknowledgement.status !== "chunk_received"
        || acknowledgement.received_chunks !== index + 1 || acknowledgement.total_chunks !== totalChunks) {
        throw new NapcatApiError(503, "QQ_NATIVE_UPLOAD_CHUNK_UNCONFIRMED");
      }
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, position);
    if (extra.bytesRead || hash.digest("hex") !== expectedHash) throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED");
    const response = await callNapcatApi(context, selection, "upload_file_stream", {
      stream_id: target.streamId, file_retention: target.fileRetentionMs, is_complete: true
    }, actions, signal);
    const result = response as Record<string, unknown> | null;
    if (result?.type !== "response" || result.status !== "file_complete" || result.stream_id !== target.streamId
      || result.file_size !== stat.size || result.sha256 !== expectedHash || result.received_chunks !== totalChunks || result.total_chunks !== totalChunks
      || typeof result.file_path !== "string" || !result.file_path || /[\x00-\x1f\x7f]/.test(result.file_path)) {
      throw new NapcatApiError(503, "QQ_NATIVE_UPLOAD_COMPLETION_UNCONFIRMED");
    }
    await verifyNapcatApiIdentity(context, selection, signal);
    return { nativePath: result.file_path, bytes: stat.size, sha256: expectedHash };
  } catch (error) {
    if (error instanceof NapcatApiError || error instanceof QqReadError) throw error;
    throw new NapcatApiError(503, signal.aborted ? "QQ_NATIVE_EGRESS_ATTACHMENT_ABORTED" : "QQ_NATIVE_UPLOAD_TRANSFER_UNKNOWN");
  } finally {
    await file.close();
  }
}

export function napcatApiFailure(error: unknown): { status: number; body: { code: -1; errorCode: string } } {
  if (error instanceof NapcatApiError || error instanceof QqReadError) return { status: error.status, body: { code: -1, errorCode: error.code } };
  return { status: 503, body: { code: -1, errorCode: "QQ_API_UPSTREAM_UNAVAILABLE" } };
}
