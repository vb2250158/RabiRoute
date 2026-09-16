import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readUpload(filePath, signal) {
  const initial = await lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("Upload requires a regular file, not a symlink.");
  if (initial.size > MAX_UPLOAD_BYTES) throw new Error("Upload exceeds the 2 GiB client limit.");
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size) throw new Error("Upload file changed before reading.");
    // Hash in bounded chunks; the same open descriptor streams a second pass.
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > current.size) throw new Error("Upload file grew while reading.");
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const entry = await lstat(filePath);
    if (bytes !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs || entry.isSymbolicLink() || entry.dev !== current.dev || entry.ino !== current.ino) throw new Error("Upload file changed while reading.");
    const sha256 = digest.digest("hex");
    async function* stream() {
      let offset = 0;
      const sent = createHash("sha256");
      while (true) {
        signal.throwIfAborted();
        const chunk = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > current.size) throw new Error("Upload file grew during transmission.");
        sent.update(chunk.subarray(0, bytesRead));
        yield chunk.subarray(0, bytesRead);
      }
      const final = await handle.stat();
      const entry = await lstat(filePath);
      if (offset !== current.size || final.size !== current.size || final.mtimeMs !== current.mtimeMs || entry.isSymbolicLink() || entry.dev !== current.dev || entry.ino !== current.ino || sent.digest("hex") !== sha256) throw new Error("Upload file changed during transmission.");
    }
    return { size: current.size, sha256, stream: stream(), close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

function managerOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Manager address must be an explicit HTTP(S) origin without credentials.");
  }
  return url.origin;
}

function relativeTarget(origin, value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n#]/.test(value)) {
    throw new Error("Manager request requires a same-origin relative path.");
  }
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password) throw new Error("Cross-origin Manager request rejected.");
  return url;
}

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Manager response exceeds the client limit.");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Transport only: Manager owns authorization, business state and mutation receipts. */
export function createManagerClient({ managerUrl, credential, agentId, fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 30 * 60_000 }) {
  const origin = managerOrigin(managerUrl);
  if (!credential || !agentId) throw new Error("A node credential and Agent identity are required.");
  async function request(method, target, { body, headers = {} } = {}, upload) {
    method = String(method).toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported Manager method.");
    const url = relativeTarget(origin, target);
    const outgoing = {
      authorization: `Bearer ${credential}`,
      "x-rabiroute-agent-id": agentId,
      accept: "application/json"
    };
    for (const [key, value] of Object.entries(headers)) {
      const normalized = key.toLowerCase();
      if (!["if-match", "idempotency-key"].includes(normalized) || typeof value !== "string" || /[\r\n]/.test(value)) {
        throw new Error("Only If-Match and Idempotency-Key may be supplied by the caller.");
      }
      outgoing[normalized] = value;
    }
    if (body !== undefined) {
      if (method === "GET" || method === "HEAD") throw new Error("Read requests cannot carry a body.");
      outgoing["content-type"] = "application/json";
    }
    if (upload) {
      outgoing["content-type"] = "application/octet-stream";
      outgoing["x-rabiroute-file-name"] = encodeURIComponent(upload.fileName);
      outgoing["x-rabiroute-content-sha256"] = upload.sha256;
      outgoing["idempotency-key"] = upload.id;
      outgoing["content-length"] = String(upload.size);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method, headers: outgoing, redirect: "error", signal: upload?.signal ?? AbortSignal.timeout(timeoutMs),
        ...(upload ? { body: upload.stream, duplex: "half" } : body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
      });
      const text = await boundedResponse(response);
      let data;
      try { data = JSON.parse(text); } catch { data = undefined; }
      return {
        statusCode: response.status, ok: response.ok, body: text,
        headers: Object.fromEntries(["etag", "idempotency-key", "x-request-id"].flatMap(key => response.headers.has(key) ? [[key, response.headers.get(key)]] : [])),
        uncertain: !["GET", "HEAD"].includes(method) && (response.status >= 500 || data?.uncertain === true)
      };
    } catch {
      // Do not echo transport errors that may contain request headers. Never replay writes.
      return { statusCode: response?.status ?? 0, ok: false, body: "Manager transport failed; inspect authoritative state before retrying a mutation.", headers: {}, uncertain: !["GET", "HEAD"].includes(method) };
    }
  }
  async function verifiedRequest(method, target, options = {}, upload) {
    const meta = await request("GET", "/meta");
    if (!meta.ok) return meta;
    let identity;
    try { identity = JSON.parse(meta.body); } catch { throw new Error("Manager metadata is not valid JSON."); }
    if (identity.health?.state !== "healthy" || identity.health?.requiredReady !== true || !identity.applicationGenerationId || !identity.managerInstanceId) {
      throw new Error("Manager generation is not ready or has no identity.");
    }
    if (target === "/meta" && String(method).toUpperCase() === "GET") return meta;
    const result = await request(method, target, options, upload);
    const after = await request("GET", "/meta");
    let current;
    try { current = JSON.parse(after.body); } catch { current = undefined; }
    const identityChanged = !after.ok || current?.health?.state !== "healthy" || current?.health?.requiredReady !== true || current?.applicationGenerationId !== identity.applicationGenerationId || current?.managerInstanceId !== identity.managerInstanceId;
    return {
      ...result,
      uncertain: result.uncertain || (identityChanged && !["GET", "HEAD"].includes(String(method).toUpperCase())),
      identityChanged,
      identity: { applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId }
    };
  }
  async function invoke(method, target, options = {}) {
    return verifiedRequest(method, target, options);
  }
  async function upload(filePath, uploadId) {
    if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw new Error("Upload requires an explicit stable --upload-id UUID; never generate a new ID after a timeout.");
    if (typeof filePath !== "string" || !filePath) throw new Error("Upload requires a file path.");
    const signal = AbortSignal.timeout(uploadTimeoutMs);
    const source = await readUpload(filePath, signal);
    const fileName = path.basename(filePath);
    const { sha256, size } = source;
    const target = `/api/agent/uploads/${uploadId}`;
    let result;
    try {
      result = await verifiedRequest("PUT", target, {}, { id: uploadId, fileName, sha256, size, stream: source.stream, signal });
    } finally {
      // Cleanup must not replace an authoritative receipt or the original failure.
      try { await source.stream.return(); } catch { /* Stream errors are handled by transport. */ }
      try { await source.close(); } catch { /* Do not turn a completed upload into a retry. */ }
    }
    const query = { method: "GET", path: target };
    let envelope;
    try { envelope = JSON.parse(result.body); } catch { /* Invalid receipts cannot prove success. */ }
    const dto = envelope?.data;
    const validReceipt = envelope?.code === 0 && dto?.id === uploadId && dto.fileName === fileName && dto.size === size && dto.sha256 === sha256 && typeof dto.expiresAt === "string" && Number.isFinite(Date.parse(dto.expiresAt)) && !Object.hasOwn(dto, "path") && result.headers["idempotency-key"] === uploadId;
    const uncertain = result.uncertain || (result.ok && !validReceipt);
    // Return only the public DTO, never an unexpected server filesystem path.
    const publicBody = validReceipt ? JSON.stringify({ code: 0, data: { id: dto.id, fileName: dto.fileName, size: dto.size, sha256: dto.sha256, expiresAt: dto.expiresAt } }) : "Upload was not confirmed; inspect the HTTP status and query the stable upload ID.";
    if (!result.ok || uncertain) return { ...result, body: publicBody, ok: false, uncertain, query, guidance: `${result.statusCode === 413 ? "The configured Manager upload limit was exceeded; the 2 GiB client ceiling does not override a lower Manager limit. " : ""}Query GET ${target} with the same Agent identity before any retry. Do not change the upload ID, automatically upload again, or send a message.` };
    return { ...result, body: publicBody, query, guidance: "Uploaded only; nothing was sent. To send explicitly, use /api/agent/send with payload: {type:'file',fileId:...,fileSha256:...} and an authorized target; fileSha256 is required to bind the exact uploaded bytes.", payload: { type: "file", fileId: dto.id, fileSha256: dto.sha256 } };
  }
  return { invoke, upload };
}
