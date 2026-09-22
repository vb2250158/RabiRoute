import { constants } from "node:fs";
import fsPromises, { lstat, open } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { businessReady, createEndpointSession, sameIdentity } from "./endpoint-session.mjs";

// Keep aligned with the server skill ZIP archive ceiling (68 MiB).
export const MAX_SKILL_DOWNLOAD_BYTES = 68 * 1024 * 1024;
export function isSkillDownloadTarget(target) {
  if (typeof target !== "string") return false;
  const match = /^\/(?:api\/)?roles\/([^/?#\\]+)\/skills\/([^/?#\\]+)\/download$/.exec(target);
  if (!match) return false;
  try {
    return match.slice(1).every(part => {
      const value = decodeURIComponent(part);
      return value.trim().length > 0 && !/[.\s]$/.test(value) && !/[\\/:\u0000-\u0020\u007f]/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
    });
  } catch { return false; }
}

const DOWNLOAD_ERRORS = Object.freeze({
  HTTP_401: "Node authentication failed.", HTTP_403: "Download access denied.",
  HTTP_404: "Requested skill was not found.", HTTP_409: "Skill snapshot conflicted.",
  HTTP_413: "Manager archive size limit exceeded.", HTTP_503: "Manager download service unavailable.",
  HTTP_ERROR: "Manager returned an unexpected HTTP status.",
  OUTPUT_EXISTS: "Local output already exists and was not overwritten.",
  HASH_MISMATCH: "ZIP SHA-256 does not match the response header.",
  LENGTH_MISMATCH: "ZIP length does not match the response header.",
  TOO_LARGE: "ZIP exceeds the client size limit.", INVALID_ZIP: "Invalid ZIP headers or signature.",
  METADATA_INVALID: "Manager metadata is invalid.", MANAGER_NOT_READY: "Manager is not ready.",
  IDENTITY_CHANGED: "Manager identity changed during download.",
  TRANSPORT: "Download transport failed.", CANCELLED: "Download cancelled or timed out.",
  FILESYSTEM: "Local download filesystem operation failed.",
  LINK_UNSUPPORTED: "Destination filesystem does not support the required atomic hard link; no fallback was attempted.",
  CLEANUP_FAILED: "Temporary-file cleanup failed; inspect local partial files."
});
export class SkillDownloadError extends Error {
  constructor(code, statusCode = 0, committed = false) {
    const safeCode = Object.hasOwn(DOWNLOAD_ERRORS, code) ? code : "TRANSPORT";
    const safeStatus = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0;
    super(`Skill download [${safeCode}] HTTP ${safeStatus}: ${DOWNLOAD_ERRORS[safeCode]} ${committed === true ? "The complete destination may already exist (committed:true); manually verify its SHA-256 before any further action." : "Output was not confirmed."} Do not retry automatically.`);
    this.name = "SkillDownloadError";
    this.code = safeCode;
    this.statusCode = safeStatus;
    this.committed = committed === true;
  }
}


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
export function createManagerClient({ managerUrl, credential, agentId, config, configPath, endpointSession, discover, fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 30 * 60_000, downloadTimeoutMs = 120_000 }) {
  let origin = managerOrigin(config?.managerUrl || managerUrl);
  credential ||= config?.nodeCredential;
  // Explicit legacy origins retain their existing contract; enrolled configs
  // with a stable GUID (or injected discovery) use dynamic endpoint recovery.
  const session = endpointSession || ((configPath && config?.managerGuid) || discover
    ? createEndpointSession({ config: config || { managerUrl, nodeCredential: credential }, configPath, fetchImpl, discover, timeoutMs: Math.min(timeoutMs, 5000) })
    : null);
  if (!credential || !agentId) throw new Error("A node credential and Agent identity are required.");
  async function request(method, target, { body, headers = {} } = {}, upload, requestOrigin = origin) {
    method = String(method).toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported Manager method.");
    const url = relativeTarget(requestOrigin, target);
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
      if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/zip") {
        await response.body?.cancel();
        throw new Error("Binary ZIP responses require the explicit download operation.");
      }
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
    const diagnostic = target === "/meta" && String(method).toUpperCase() === "GET";
    const read = ["GET", "HEAD"].includes(String(method).toUpperCase());
    relativeTarget(origin, target);
    let endpoint;
    if (session) endpoint = await session.ensure({ diagnostic });
    else {
      const meta = await request("GET", "/meta");
      if (!meta.ok) return meta;
      let identity; try { identity = JSON.parse(meta.body); } catch { throw new Error("Manager metadata is not valid JSON."); }
      if (!identity.applicationGenerationId || !identity.managerInstanceId) throw new Error("Manager generation is not ready or has no identity.");
      if (!diagnostic && !businessReady(identity)) throw new Error("Manager generation is not ready or has no identity.");
      endpoint = { managerUrl: origin, meta: identity, generation: identity.applicationGenerationId, instance: identity.managerInstanceId };
    }
    for (let attempt = 0; ; attempt++) {
      const requestOrigin = managerOrigin(endpoint.managerUrl);
      const identity = endpoint.meta || {};
      // Authenticated exact /meta remains an Agent authorization check; public preflight is credential-free.
      const result = await request(method, target, options, upload, requestOrigin);
      let current;
      try { const response = await request("GET", "/meta", {}, undefined, requestOrigin); current = response.ok ? JSON.parse(response.body) : undefined; } catch { current = undefined; }
      const identityChanged = !current || !sameIdentity(current, identity);
      if (read && session && attempt === 0 && (identityChanged || result.statusCode === 0 || result.statusCode >= 500)) {
        try { endpoint = await session.ensure({ diagnostic, forceDiscovery: true }); continue; } catch { /* Return the original failed read; never replay a mutation. */ }
      }
      return { ...result, uncertain: result.uncertain || (identityChanged && !read), identityChanged,
        identity: { applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId } };
    }
  }
  async function invoke(method, target, options = {}) {
    if (isSkillDownloadTarget(target)) throw new Error("Skill download requires the explicit download operation and local output path.");
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
  async function download(target, outputPath, { signal: callerSignal } = {}) {
    if (!isSkillDownloadTarget(target)) throw new Error("Download requires an exact role skill download path without a query.");
    if (typeof outputPath !== "string" || !outputPath.trim() || outputPath.includes("\0")) throw new Error("Download requires an explicit local output path.");
    const finalPath = path.resolve(outputPath);
    const temporaryPath = path.join(path.dirname(finalPath), `.rabi-download-${randomUUID()}.partial`);
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(downloadTimeoutMs)]) : AbortSignal.timeout(downloadTimeoutMs);
    const headers = { authorization: `Bearer ${credential}`, "x-rabiroute-agent-id": agentId };
    let downloadOrigin = origin;
    let verifiedEndpoint;
    let handle;
    let reader;
    let temporaryCreated = false;
    let committed = false;
    let statusCode = 0;
    let failureCode = "FILESYSTEM";
    const failure = code => new SkillDownloadError(code, statusCode, committed);
    function checkStatus(response) {
      statusCode = response.status;
      if (statusCode !== 200) throw failure(Object.hasOwn(DOWNLOAD_ERRORS, `HTTP_${statusCode}`) ? `HTTP_${statusCode}` : "HTTP_ERROR");
    }
    // Race reads as well as fetch: a stalled body must not retain a partial file.
    async function bounded(operation) {
      signal.throwIfAborted();
      let listener;
      try {
        return await Promise.race([operation(), new Promise((_, reject) => {
          listener = () => reject(new Error("Download cancelled or timed out."));
          signal.addEventListener("abort", listener, { once: true });
          if (signal.aborted) listener();
        })]);
      } finally { signal.removeEventListener("abort", listener); }
    }
    async function metadata(requireReady) {
      failureCode = "TRANSPORT";
      const response = await bounded(() => fetchImpl(relativeTarget(downloadOrigin, "/meta"), { method: "GET", headers: { ...headers, accept: "application/json" }, redirect: "error", signal }));
      if (response.status !== 200) { response.body?.cancel().catch(() => {}); checkStatus(response); }
      failureCode = "METADATA_INVALID";
      if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        response.body?.cancel().catch(() => {});
        throw new Error("Metadata unavailable.");
      }
      const value = JSON.parse(await bounded(() => boundedResponse(response)));
      if (typeof value.applicationGenerationId !== "string" || !value.applicationGenerationId.trim() || typeof value.managerInstanceId !== "string" || !value.managerInstanceId.trim()) throw new Error("Metadata identity missing.");
      if (requireReady && (value.health?.live !== true || value.health?.requiredReady !== true || !["healthy", "degraded"].includes(value.health?.state))) throw failure("MANAGER_NOT_READY");
      return { applicationGenerationId: value.applicationGenerationId, managerInstanceId: value.managerInstanceId };
    }
    try {
      try { await lstat(finalPath); throw failure("OUTPUT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (session) {
        failureCode = "TRANSPORT";
        verifiedEndpoint = await bounded(() => session.ensure());
        downloadOrigin = managerOrigin(verifiedEndpoint.managerUrl);
      }
      const identity = await metadata(true);
      if (verifiedEndpoint && !sameIdentity(identity, verifiedEndpoint.meta)) throw failure("IDENTITY_CHANGED");
      failureCode = "TRANSPORT";
      const response = await bounded(() => fetchImpl(relativeTarget(downloadOrigin, target), { method: "GET", headers: { ...headers, accept: "application/zip", "accept-encoding": "identity" }, redirect: "error", signal }));
      reader = response.body?.getReader();
      checkStatus(response);
      const lengthHeader = response.headers.get("content-length");
      const expectedHash = response.headers.get("x-rabiroute-content-sha256");
      const expectedLength = Number(lengthHeader);
      if (response.headers.get("content-type")?.trim().toLowerCase() !== "application/zip" || !/^[1-9][0-9]*$/.test(lengthHeader ?? "") || !Number.isSafeInteger(expectedLength) || !/^[0-9a-f]{64}$/i.test(expectedHash ?? "") || !reader) throw failure("INVALID_ZIP");
      if (expectedLength > MAX_SKILL_DOWNLOAD_BYTES) throw failure("TOO_LARGE");
      failureCode = "FILESYSTEM";
      handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let signature = Buffer.alloc(0);
      while (true) {
        failureCode = "TRANSPORT";
        const chunk = await bounded(() => reader.read());
        if (chunk.done) break;
        const bytes = Buffer.from(chunk.value);
        sizeBytes += bytes.length;
        if (sizeBytes > MAX_SKILL_DOWNLOAD_BYTES) throw failure("TOO_LARGE");
        if (sizeBytes > expectedLength) throw failure("LENGTH_MISMATCH");
        if (signature.length < 4) signature = Buffer.concat([signature, bytes.subarray(0, 4 - signature.length)]);
        hash.update(bytes);
        let offset = 0;
        failureCode = "FILESYSTEM";
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          if (!bytesWritten) throw new Error("Download write failed.");
          offset += bytesWritten;
        }
      }
      const sha256 = hash.digest("hex");
      if (sizeBytes !== expectedLength) throw failure("LENGTH_MISMATCH");
      if (sha256 !== expectedHash.toLowerCase()) throw failure("HASH_MISMATCH");
      if (!["504b0304", "504b0506"].includes(signature.toString("hex"))) throw failure("INVALID_ZIP");
      failureCode = "FILESYSTEM";
      await handle.sync();
      await handle.close();
      handle = undefined;
      const after = await metadata(false);
      if (after.applicationGenerationId !== identity.applicationGenerationId || after.managerInstanceId !== identity.managerInstanceId) throw failure("IDENTITY_CHANGED");
      signal.throwIfAborted();
      failureCode = "FILESYSTEM";
      // Same-directory hard link is atomic and fails if the destination exists (including Windows).
      // Unlike rename, it never replaces a file created concurrently by another caller.
      try { await fsPromises.link(temporaryPath, finalPath); }
      catch (error) {
        if (error.code === "EEXIST") throw failure("OUTPUT_EXISTS");
        if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EPERM"].includes(error.code)) throw failure("LINK_UNSUPPORTED");
        throw failure("FILESYSTEM");
      }
      committed = true;
      failureCode = "CLEANUP_FAILED";
      await fsPromises.unlink(temporaryPath);
      temporaryCreated = false;
      return { ok: true, statusCode: 200, path: finalPath, sizeBytes, sha256, identity };
    } catch (error) {
      // Return only our closed error vocabulary, never the original exception or server body.
      if (error instanceof SkillDownloadError) throw error;
      throw failure(signal.aborted && !committed ? "CANCELLED" : failureCode);
    } finally {
      if (reader) { try { const cancelled = reader.cancel(); cancelled?.catch(() => {}); } catch { /* Preserve failure. */ } }
      let cleanupFailed = false;
      try { if (handle) await handle.close(); } catch { cleanupFailed = true; }
      try { if (temporaryCreated) await fsPromises.unlink(temporaryPath); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw failure("CLEANUP_FAILED");
    }
  }
  return { invoke, upload, download };
}
