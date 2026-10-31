import { createTimeoutSettings } from "./timeout-settings.mjs";
import { constants, readFileSync } from "node:fs";
import fsPromises, { lstat, open } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { businessReady, createEndpointSession, sameIdentity } from "./endpoint-session.mjs";
import { createApiCatalogClient } from "./api-catalog-client.mjs";
import { validApiHttpMethod } from "./api-path-template.mjs";
import { openApiWebSocket } from "./api-websocket-client.mjs";
import { submitDeliveryToOwner, rememberDeliveryDescriptor, readDeliveryDescriptor } from "./delivery-control.mjs";

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


function metadataIdentity(raw) {
  return raw?.data && typeof raw.data === "object" ? raw.data : raw;
}

// Only the dedicated skill-download metadata reader is bounded here; public
// responses use the caller's optional maxResponseBytes or streaming consumer.
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readUpload(filePath, signal) {
  const initial = await lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("Upload requires a regular file, not a symlink.");
  if (!Number.isSafeInteger(initial.size) || initial.size < 0) throw new Error("Upload size cannot be represented as an exact byte count.");
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

// Deny transport-owned headers, not business capabilities. New public headers
// pass without a client release; authentication, hop proofs and framing do not.
// x-rabilink-resource-owner selects stored data on an already authenticated public
// connection; the resources key and tunnel proofs remain transport-owned.
const TRANSPORT_HEADERS = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate", "www-authenticate", "cookie", "set-cookie",
  "host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect",
  "forwarded", "via", "x-real-ip", "x-rabiroute-agent-id", "x-rabiroute-agent-type", "x-rabiroute-session-id", "x-rabiroute-node-id", "x-rabiroute-host-token", "x-rabiroute-webgui-token", "x-rabiroute-peer-proxy", "x-rabiroute-relay-proxy",
  "x-rabiroute-listener-lease",
  "x-rabilink-token", "x-rabilink-resource-key", "x-rabiroute-expected-generation", "x-rabiroute-expected-application-generation-id", "x-rabiroute-expected-manager-instance-id"
]);
function transportHeader(name) {
  return TRANSPORT_HEADERS.has(name) || /^(?:proxy-|sec-|x-forwarded-|x-rabilink-(?:internal-|tunnel-)|x-rabiroute-internal-)/.test(name);
}
function callerHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Manager headers must be an object.");
  const result = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || transportHeader(name)) throw new Error("Caller cannot override a transport-owned or invalid header.");
    if (typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error("Manager header values must be valid HTTP strings.");
    if (Object.hasOwn(result, name)) throw new Error("Duplicate Manager header.");
    result[name] = value;
  }
  return result;
}
function explicitNativeHeaders(headers = {}, nodeCredential) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Native credential headers must be an explicit object.");
  const result = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (["authorization", "cookie"].includes(name)) {
      if (typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error("Invalid native credential header.");
    } else callerHeaders({ [key]: value });
    if (Object.hasOwn(result, name)) throw new Error("Duplicate native credential header.");
    if (nodeCredential && value.includes(nodeCredential)) throw new Error("A Manager node credential cannot be reused as a native target credential.");
    result[name] = value;
  }
  return result;
}
function requestOptions(method, options) {
  const headers = callerHeaders(options.headers ?? {});
  const bodies = ["body", "bodyText", "bodyBytes", "bodyStream"].filter(key => options[key] !== undefined);
  if (bodies.length > 1) throw new Error("Choose exactly one Manager request body format.");
  if (bodies.length && ["GET", "HEAD"].includes(method)) throw new Error("Read requests cannot carry a body.");
  if (options.bodyText !== undefined && typeof options.bodyText !== "string") throw new Error("bodyText must be a string.");
  if (options.bodyBytes !== undefined && !(options.bodyBytes instanceof Uint8Array) && !(options.bodyBytes instanceof ArrayBuffer)) throw new Error("bodyBytes must be bytes.");
  if (options.bodyStream !== undefined && !options.bodyStream?.[Symbol.asyncIterator] && !options.bodyStream?.getReader) throw new Error("bodyStream must be an async iterable or ReadableStream.");
  const responseMode = options.responseMode ?? "text";
  if (!["text", "bytes", "stream"].includes(responseMode)) throw new Error("Unknown Manager response mode.");
  if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)) throw new Error("maxResponseBytes must be a positive byte budget.");
  if (responseMode === "stream" && typeof options.onChunk !== "function") throw new Error("Stream response requires an explicit onChunk consumer.");
  if (options.onResponse !== undefined && typeof options.onResponse !== "function") throw new Error("onResponse must be a function.");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 0xffffffff)) throw new Error("timeoutMs must be a positive supported millisecond deadline.");
  return { ...options, headers, responseMode };
}
// Also race injected consumers/readers: cancellation must not wait for a stalled
// body or callback. The original rejection remains observed by Promise.race.
async function withSignal(operation, signal) {
  signal.throwIfAborted();
  let listener;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      listener = () => reject(new Error("Manager request cancelled or timed out."));
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { signal.removeEventListener("abort", listener); }
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
      if (bytes > MAX_METADATA_BYTES) {
        await reader.cancel();
        throw new Error("Manager response exceeds the client limit.");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Transport only: Manager owns authorization, business state and mutation receipts. */
function buildManagerClient({ managerUrl, credential, agentType, sessionId, config, configPath, endpointSession, discover, localHost = false, fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 30 * 60_000, downloadTimeoutMs = 120_000 }, networkTransport = false) {
  if (!config && configPath) config = JSON.parse(readFileSync(configPath, "utf8"));
  const timeouts = createTimeoutSettings(config?.timeoutOverridesCache ?? config?.timeoutOverrides);
  let origin = managerOrigin(config?.managerUrl || managerUrl);
  credential ||= config?.nodeCredential;
  // Explicit legacy origins retain their existing contract; enrolled configs
  // with a stable GUID (or injected discovery) use dynamic endpoint recovery.
  const session = endpointSession || ((configPath && config?.managerGuid) || discover
    ? createEndpointSession({ config: config || { managerUrl, nodeCredential: credential }, configPath, fetchImpl, discover, timeoutMs: Math.min(timeoutMs, 5000), timeoutSettings: timeouts })
    : null);
  if (localHost) {
    if (!endpointSession || credential || agentType || sessionId || config || discover) throw new Error("Local Host transport requires an explicit Host endpoint session without remote credentials.");
  } else if (!credential) throw new Error("An enrolled computer credential is required.");
  if ((agentType || sessionId) && (!agentType || !sessionId || typeof agentType !== "string" || typeof sessionId !== "string" || /[\x00-\x1f\x7f]/.test(agentType + sessionId))) throw new Error("Provide an explicit Agent type and full session ID together.");
  async function request(method, target, options = {}, upload, requestOrigin = origin, verifiedIdentity, nativeBinding, nativeCredentials) {
    const { body, bodyText, bodyBytes, bodyStream, headers = {}, responseMode = "text", onChunk, onResponse } = options;
    method = String(method).toUpperCase();
    if (!validApiHttpMethod(method)) throw new Error("Invalid Manager HTTP method.");
    const url = relativeTarget(requestOrigin, target);
    if (!nativeBinding && localHost && (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Local Host transport requires HTTP loopback.");
    const outgoing = localHost || nativeBinding ? { accept: "application/json" } : {
      authorization: `Bearer ${credential}`,
      ...(agentType ? { "x-rabiroute-agent-type": agentType, "x-rabiroute-session-id": sessionId } : {}),
      accept: "application/json"
    };
    Object.assign(outgoing, callerHeaders(headers));
    if (nativeBinding && nativeCredentials) Object.assign(outgoing, nativeCredentials);
    if (nativeBinding) outgoing["x-rabiroute-listener-lease"] = nativeBinding.leaseId;
    if (verifiedIdentity) {
      outgoing["x-rabiroute-expected-application-generation-id"] = verifiedIdentity.applicationGenerationId;
      outgoing["x-rabiroute-expected-manager-instance-id"] = verifiedIdentity.managerInstanceId;
    }
    const payload = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : bodyText ?? bodyBytes ?? bodyStream;
    if (payload !== undefined) {
      if (method === "GET" || method === "HEAD") throw new Error("Read requests cannot carry a body.");
      outgoing["content-type"] ??= body !== undefined ? "application/json" : bodyText !== undefined ? "text/plain;charset=UTF-8" : "application/octet-stream";
    }
    if (upload) {
      outgoing["content-type"] = "application/octet-stream";
      outgoing["x-rabiroute-file-name"] = encodeURIComponent(upload.fileName);
      outgoing["x-rabiroute-content-sha256"] = upload.sha256;
      outgoing["idempotency-key"] = upload.id;
      outgoing["content-length"] = String(upload.size);
    }
    let response;
    let reader;
    let bytesReceived = 0;
    const chunks = [];
    // A send may still be hashing/uploading a large managed file after the
    // ordinary request deadline. Keep its original connection and deliveryId;
    // a timeout is never permission to replay the mutation.
    const requestTimeoutMs = method === "POST" && url.pathname === "/api/agent/send"
      ? timeouts.get("agent.client.send", uploadTimeoutMs) : timeouts.get("agent.client.request", timeoutMs);
    const deadline = upload?.signal ?? AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs);
    const signal = AbortSignal.any([deadline, ...(upload?.signal ? [upload.signal] : []), ...(options.signal ? [options.signal] : [])]);
    const responseHeaders = () => Object.fromEntries([...response.headers].filter(([name]) => !transportHeader(name) || ["content-length", "transfer-encoding", "connection", "keep-alive", "trailer"].includes(name)));
    try {
      response = await withSignal(() => fetchImpl(url, {
        method, headers: outgoing, redirect: "error", signal,
        ...(upload ? { body: upload.stream, duplex: "half" } : payload === undefined ? {} : { body: payload, ...(bodyStream ? { duplex: "half" } : {}) })
      }), signal);
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const textual = !type || type.startsWith("text/") || /(?:^application\/(?:json|xml|javascript|x-www-form-urlencoded)$|\+(?:json|xml)$)/.test(type);
      if (responseMode === "text" && (!textual || type === "text/event-stream")) {
        return { statusCode: response.status, ok: false, body: "Binary or event-stream response requires explicit bytes or stream consumption.", headers: responseHeaders(), transportError: "RESPONSE_MODE_REQUIRED", noReplay: true, uncertain: !["GET", "HEAD", "OPTIONS"].includes(method) };
      }
      if (onResponse) await withSignal(() => onResponse({ statusCode: response.status, ok: response.ok, headers: responseHeaders() }), signal);
      reader = response.body?.getReader();
      while (reader) {
        const chunk = await withSignal(() => reader.read(), signal);
        if (chunk.done) break;
        bytesReceived += chunk.value.byteLength;
        if (options.maxResponseBytes !== undefined && bytesReceived > options.maxResponseBytes) throw new Error("Manager response exceeds the caller byte budget.");
        const bytes = Buffer.from(chunk.value);
        if (responseMode === "stream") await withSignal(() => onChunk(bytes), signal);
        else chunks.push(bytes);
      }
      const bytes = responseMode === "stream" ? undefined : Buffer.concat(chunks);
      const text = responseMode === "text" ? bytes.toString("utf8") : undefined;
      let data;
      try { data = JSON.parse(text); } catch { data = undefined; }
      return {
        statusCode: response.status, ok: response.ok, ...(text !== undefined ? { body: text } : bytes ? { bodyBytes: bytes } : {}),
        headers: responseHeaders(), bytesReceived, responseMode, noReplay: responseMode === "stream" || bodyStream !== undefined,
        uncertain: !["GET", "HEAD", "OPTIONS"].includes(method) && (response.status >= 500 || data?.uncertain === true)
      };
    } catch {
      // Do not echo transport/consumer errors that may contain private headers.
      return { statusCode: response?.status ?? 0, ok: false, body: "Manager transport or consumer failed; inspect authoritative state before retrying a mutation.", headers: response ? responseHeaders() : {}, bytesReceived,
        transportError: signal.aborted ? "CANCELLED" : "TRANSPORT", noReplay: responseMode === "stream" || bodyStream !== undefined,
        uncertain: !["GET", "HEAD", "OPTIONS"].includes(method) };
    } finally {
      if (reader) { try { reader.cancel().catch(() => {}); reader.releaseLock(); } catch { /* Preserve original receipt. */ } }
      else { try { response?.body?.cancel().catch(() => {}); } catch { /* Preserve original receipt. */ } }
    }
  }
  async function verifiedRequest(method, target, options = {}, upload) {
    method = String(method).toUpperCase();
    if (!validApiHttpMethod(method)) throw new Error("Invalid Manager HTTP method.");
    options = requestOptions(method, options);
    const diagnostic = target === "/meta" && method === "GET";
    // Some GET operations touch persisted state (for example recent-memory views).
    // Callers may disable replay, but cannot enable replay for a mutation method.
    const touchesRecentMemory = /^\/(?:api\/)?roles\/[^/]+\/memory\/recent\/[^/]+$/.test(new URL(target, origin).pathname);
    const read = ["GET", "HEAD", "OPTIONS"].includes(method) && options.replaySafe !== false && !touchesRecentMemory && options.responseMode !== "stream" && options.bodyStream === undefined && options.onResponse === undefined;
    relativeTarget(origin, target);
    let endpoint;
    if (session) endpoint = await session.ensure({ diagnostic });
    else {
      const meta = await request("GET", "/meta");
      if (!meta.ok) return meta;
      let identity; try { identity = metadataIdentity(JSON.parse(meta.body)); } catch { throw new Error("Manager metadata is not valid JSON."); }
      if (!identity.applicationGenerationId || !identity.managerInstanceId) throw new Error("Manager generation is not ready or has no identity.");
      if (!diagnostic && !businessReady(identity)) throw new Error("Manager generation is not ready or has no identity.");
      endpoint = { managerUrl: origin, meta: identity, generation: identity.applicationGenerationId, instance: identity.managerInstanceId };
    }
    for (let attempt = 0; ; attempt++) {
      const requestOrigin = managerOrigin(endpoint.managerUrl);
      const identity = endpoint.meta || {};
      timeouts.adopt(identity);
      const configuredUploadMiB = identity.agentUploads?.maxFileMiB;
      if (upload && Number.isSafeInteger(configuredUploadMiB) && configuredUploadMiB > 0 && Number.isSafeInteger(configuredUploadMiB * 1024 ** 2) && upload.size > configuredUploadMiB * 1024 ** 2) {
        throw new Error(`Upload exceeds the current Manager agentUploads.maxFileMiB=${configuredUploadMiB}. Adjust WebGUI RabiLink configuration or data/Config.json and restart Manager to apply it.`);
      }
      // Authenticated exact /meta remains an Agent authorization check; public preflight is credential-free.
      const result = await request(method, target, options, upload, requestOrigin, identity);
      let current;
      try { const response = await request("GET", "/meta", {}, undefined, requestOrigin); current = response.ok ? metadataIdentity(JSON.parse(response.body)) : undefined; } catch { current = undefined; }
      const identityChanged = !current || !sameIdentity(current, identity);
      if (read && !result.noReplay && !options.signal?.aborted && session && attempt === 0 && (identityChanged || result.statusCode === 0 || result.statusCode >= 500 || result.transportError)) {
        try { endpoint = await session.ensure({ diagnostic, forceDiscovery: true }); continue; } catch { /* Return the original failed read; never replay a mutation. */ }
      }
      return { ...result, uncertain: Boolean(result.uncertain || (!read && (identityChanged || result.statusCode === 0 || result.statusCode >= 500 || result.transportError))), identityChanged,
        identity: { applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId } };
    }
  }
  /** Same-origin public HTTP transport. Streams are consumed with backpressure,
   * never reconnected. A caller's signal/deadline owns their lifetime. Buffered
   * reads may replay once unless replaySafe:false; mutations never replay.
   * outputPath saves bytes atomically without overwrite or printing binary. */
  async function publicRequest(method, target, options = {}, transport = verifiedRequest) {
    const verb = String(method).toUpperCase();
    if (!networkTransport && verb === "POST" && relativeTarget(origin, target).pathname === "/api/agent/threads") {
      const normalized = await readAgentJsonBody(options);
      options = normalized.options;
      if (normalized.request?.action === "send") {
        requestOptions(verb, options); // Preserve transport-header/body validation before local acceptance.
        if (!configPath || !agentType || !sessionId) throw new Error("Reliable Agent delivery requires the installed owner config and explicit source identity.");
        if (options.outputPath || options.responseMode && options.responseMode !== "text" || options.onChunk || options.onResponse) throw new Error("Reliable Agent delivery returns a JSON local-acceptance receipt; streaming output is unsupported before submission.");
        const receipt = await submitDeliveryToOwner(configPath, { intentId: normalized.request.deliveryId, agentType, sessionId, request: normalized.request });
        const accepted = receipt.accepted === true;
        const status = accepted ? "queued" : receipt.accepted === false ? "local_rejected" : "local_acceptance_unknown";
        return { ...receipt, statusCode: accepted ? 202 : receipt.accepted === false ? 409 : 0, headers: {}, noReplay: true,
          uncertain: receipt.accepted == null, body: JSON.stringify({ code: accepted ? 0 : -1, ok: receipt.ok, status,
            acceptance: receipt.acceptance, intentId: receipt.intentId, delivery: { deliveryId: receipt.deliveryId, status }, error: receipt.error }) };
      }
    }
    if (isSkillDownloadTarget(target)) throw new Error("Skill download requires the explicit download operation and local output path.");
    if (options.outputPath === undefined) return transport(method, target, options);
    if (typeof options.outputPath !== "string" || !options.outputPath.trim() || options.outputPath.includes("\0")) throw new Error("Output requires an explicit local path.");
    if (options.onChunk !== undefined) throw new Error("Output and onChunk consumers are mutually exclusive.");
    // Validate before opening any file or making a network call.
    requestOptions(String(method).toUpperCase(), { ...options, responseMode: "stream", onChunk: () => {} });
    const finalPath = path.resolve(options.outputPath);
    const temporaryPath = path.join(path.dirname(finalPath), `.rabi-response-${randomUUID()}.partial`);
    let handle;
    let created = false;
    let committed = false;
    let result;
    try {
      try { await lstat(finalPath); throw new Error("Output already exists; no overwrite was attempted."); } catch (error) { if (error.code !== "ENOENT") throw error; }
      handle = await open(temporaryPath, "wx", 0o600);
      created = true;
      const hash = createHash("sha256");
      result = await transport(method, target, { ...options, responseMode: "stream", replaySafe: false, onChunk: async bytes => {
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          if (!bytesWritten) throw new Error("Output write failed.");
          offset += bytesWritten;
        }
        hash.update(bytes);
      } });
      if (!result.ok || result.identityChanged || result.uncertain) return { ...result, ok: false, outputCommitted: false };
      options.signal?.throwIfAborted();
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsPromises.link(temporaryPath, finalPath);
      committed = true;
      return { ...result, path: finalPath, sha256: hash.digest("hex"), outputCommitted: true };
    } catch {
      return { ...(result ?? { statusCode: 0, headers: {} }), ok: false, noReplay: true, outputCommitted: committed, transportError: "OUTPUT_FAILED",
        uncertain: result?.uncertain ?? false, body: "Local output was not confirmed; no overwrite or automatic replay was attempted." };
    } finally {
      try { if (handle) await handle.close(); } catch { /* Preserve request result. */ }
      try { if (created) await fsPromises.unlink(temporaryPath); } catch { throw new Error("Local response cleanup failed; inspect partial files. Do not replay automatically."); }
    }
  }
  // Existing JSON/text callers share the same transport, not a second policy.
  const invoke = publicRequest;
  async function upload(filePath, uploadId) {
    if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw new Error("Upload requires an explicit stable --upload-id UUID; never generate a new ID after a timeout.");
    if (typeof filePath !== "string" || !filePath) throw new Error("Upload requires a file path.");
    const signal = AbortSignal.timeout(timeouts.get("agent.client.upload", uploadTimeoutMs));
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
    if (!result.ok || uncertain) return { ...result, body: publicBody, ok: false, uncertain, query, guidance: `${result.statusCode === 413 ? "The configured Manager upload limit was exceeded; adjust agentUploads.maxFileMiB in WebGUI RabiLink configuration or data/Config.json and restart Manager to apply it. " : ""}Query GET ${target} with the same Agent identity before any retry. Do not change the upload ID, automatically upload again, or send a message.` };
    return { ...result, body: publicBody, query, guidance: "Uploaded only; nothing was sent. To send explicitly, use /api/agent/send with payload: {type:'file',fileId:...,fileSha256:...} and an authorized target; fileSha256 is required to bind the exact uploaded bytes.", payload: { type: "file", fileId: dto.id, fileSha256: dto.sha256 } };
  }
  async function download(target, outputPath, { signal: callerSignal } = {}) {
    if (!isSkillDownloadTarget(target)) throw new Error("Download requires an exact role skill download path without a query.");
    if (typeof outputPath !== "string" || !outputPath.trim() || outputPath.includes("\0")) throw new Error("Download requires an explicit local output path.");
    const finalPath = path.resolve(outputPath);
    const temporaryPath = path.join(path.dirname(finalPath), `.rabi-download-${randomUUID()}.partial`);
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeouts.get("agent.client.download", downloadTimeoutMs))]) : AbortSignal.timeout(timeouts.get("agent.client.download", downloadTimeoutMs));
    const headers = { authorization: `Bearer ${credential}`, ...(agentType ? { "x-rabiroute-agent-type": agentType, "x-rabiroute-session-id": sessionId } : {}) };
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
      const value = metadataIdentity(JSON.parse(await bounded(() => boundedResponse(response))));
      if (typeof value.applicationGenerationId !== "string" || !value.applicationGenerationId.trim() || typeof value.managerInstanceId !== "string" || !value.managerInstanceId.trim()) throw new Error("Metadata identity missing.");
      if (requireReady && (value.health?.live !== true || !["healthy", "degraded"].includes(value.health?.state))) throw failure("MANAGER_NOT_READY");
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
  async function openWebSocket(target, options, contract, expected) {
    const headers = callerHeaders(options.headers ?? {});
    let endpoint;
    if (session) endpoint = await session.ensure();
    else {
      const response = await request("GET", "/meta", { signal: options.signal });
      let meta; try { meta = metadataIdentity(JSON.parse(response.body)); } catch { }
      if (!response.ok || !meta?.applicationGenerationId || !meta.managerInstanceId || !businessReady(meta)) throw new Error("Manager generation is not ready for a WebSocket connection.");
      endpoint = { managerUrl: origin, meta };
    }
    const identity = endpoint.meta;
    if (!sameIdentity(identity, expected)) { const error = new Error("Manager identity changed after API discovery; refresh before opening a connection."); error.code = "IDENTITY_CHANGED"; throw error; }
    const requestOrigin = managerOrigin(endpoint.managerUrl), url = relativeTarget(requestOrigin, target);
    if (localHost && (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Local Host transport requires HTTP loopback.");
    if (!localHost) headers.authorization = `Bearer ${credential}`;
    if (agentType) { headers["x-rabiroute-agent-type"] = agentType; headers["x-rabiroute-session-id"] = sessionId; }
    headers["x-rabiroute-expected-application-generation-id"] = identity.applicationGenerationId;
    headers["x-rabiroute-expected-manager-instance-id"] = identity.managerInstanceId;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return openApiWebSocket({ url, headers, contract, onMessage: options.onMessage, onOpen: options.onOpen, onClose: options.onClose,
      signal: options.signal, protocols: options.protocols, maxMessageBytes: options.maxMessageBytes, maxBufferedBytes: options.maxBufferedBytes,
      drainOnRemoteClose: options.drainOnRemoteClose,
      timeoutMs: options.timeoutMs ?? timeouts.get("agent.client.request", timeoutMs), verifyIdentity: async signal => {
        const result = await request("GET", "/meta", { signal }, undefined, requestOrigin);
        let current; try { current = metadataIdentity(JSON.parse(result.body)); } catch { }
        if (!result.ok || !current || !sameIdentity(current, identity)) throw new Error("WebSocket Manager identity changed.");
      } });
  }
  async function externalEndpoint(entry, expected, signal) {
    // Only authenticated, identity-confirmed discovery selects native addresses.
    // Its node credential is used exclusively on the Manager connection.
    const binding = entry.binding;
    if (binding?.kind !== "external-listener" || binding.invocation !== "native") throw new Error("External listener requires its native protocol connector.");
    const endpoint = session ? await session.ensure() : { managerUrl: origin };
    const receipt = await publicRequest("GET", `/api/agent/help?operationId=${encodeURIComponent(entry.id)}`, { signal, replaySafe: false });
    let data; try { data = JSON.parse(receipt.body)?.data; } catch { }
    const current = data?.operations?.find(value => value.id === entry.id);
    if (!receipt.ok || receipt.uncertain || receipt.identityChanged || !sameIdentity(data, expected)
      || current?.contractDigest !== entry.contractDigest || JSON.stringify(current?.binding) !== JSON.stringify(binding)
      || JSON.stringify(current?.access) !== JSON.stringify(entry.access)) {
      const error = new Error("External listener identity or binding changed; refresh discovery before another call."); error.code = "API_LISTENER_BINDING_CHANGED"; throw error;
    }
    if (entry.access) return { binding, access: entry.access };
    const manager = new URL(endpoint.managerUrl), address = binding.address;
    const hostname = address.hostname ?? manager.hostname;
    const loopback = name => ["127.0.0.1", "localhost", "[::1]"].includes(name);
    if (loopback(hostname) && !loopback(manager.hostname)) throw new Error("This listener is bound to the Manager computer's loopback; the current connection cannot reach its native address.");
    // No URL path, credentials, query or arbitrary scheme can enter this resolver.
    const listenerOrigin = managerOrigin(`${address.protocol}://${hostname}:${address.port}`);
    return { listenerOrigin, binding };
  }
  async function requestExternal(method, target, options, entry, expected) {
    const { nativeHeaders, ...businessOptions } = options;
    const nativeCredentials = nativeHeaders === undefined ? undefined : explicitNativeHeaders(nativeHeaders, credential);
    const { listenerOrigin, binding, access } = await externalEndpoint(entry, expected, options.signal);
    if (access && nativeCredentials) throw new Error("Explicit native credentials currently require the direct native connector; this Manager owner mapping does not forward credentials.");
    const resolvedTarget = access ? access.pathPrefix + target : target;
    const resolvedOptions = access ? { ...businessOptions, headers: { ...options.headers, [access.contractHeader]: access.contractDigest } } : businessOptions;
    return publicRequest(method, resolvedTarget, resolvedOptions, async (verb, path, nativeOptions) => {
      const result = access ? await verifiedRequest(verb, path, { ...nativeOptions, replaySafe: false })
        : await request(verb, path, requestOptions(verb, nativeOptions), undefined, listenerOrigin, undefined, binding, nativeCredentials);
      let bindingChanged = false;
      try { await externalEndpoint(entry, expected, options.signal); } catch { bindingChanged = true; }
      return { ...result, bindingChanged, identity: { applicationGenerationId: expected.applicationGenerationId, managerInstanceId: expected.managerInstanceId },
        uncertain: Boolean(result.uncertain || bindingChanged), noReplay: true };
    });
  }
  async function openExternalWebSocket(target, options, contract, expected, entry) {
    const { listenerOrigin, binding } = await externalEndpoint(entry, expected, options.signal);
    const url = relativeTarget(listenerOrigin, target);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return openApiWebSocket({ url, headers: { ...callerHeaders(options.headers ?? {}), ...explicitNativeHeaders(options.nativeHeaders, credential), "x-rabiroute-listener-lease": binding.leaseId }, contract,
      onMessage: options.onMessage, onOpen: options.onOpen, onClose: options.onClose, signal: options.signal, protocols: options.protocols,
      maxMessageBytes: options.maxMessageBytes, maxBufferedBytes: options.maxBufferedBytes, drainOnRemoteClose: options.drainOnRemoteClose,
      timeoutMs: options.timeoutMs ?? timeouts.get("agent.client.request", timeoutMs), verifyIdentity: signal => externalEndpoint(entry, expected, signal) });
  }
  async function readAgentJsonBody(options) {
    requestOptions("POST", options);
    let bytes;
    if (options.body !== undefined) bytes = Buffer.from(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    else if (options.bodyText !== undefined) bytes = Buffer.from(options.bodyText);
    else if (options.bodyBytes !== undefined) bytes = Buffer.from(options.bodyBytes);
    else if (options.bodyStream !== undefined) {
      const chunks = []; let size = 0;
      const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? timeouts.get("agent.client.request", timeoutMs)), ...(options.signal ? [options.signal] : [])]);
      const iterator = options.bodyStream[Symbol.asyncIterator]?.();
      if (!iterator) throw new Error("Agent delivery JSON requires a finite async byte iterable.");
      try {
        while (true) {
          const part = await withSignal(() => iterator.next(), signal); if (part.done) break;
          const chunk = Buffer.from(part.value); size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error("Agent delivery JSON exceeds the durable 2 MiB envelope limit.");
          chunks.push(chunk);
        }
      } finally { const released = iterator.return?.(); released?.catch?.(() => {}); }
      bytes = Buffer.concat(chunks);
    } else throw new Error("Agent action POST requires a JSON request body before local acceptance.");
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Agent delivery JSON exceeds the durable 2 MiB envelope limit.");
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Agent action POST requires valid UTF-8 JSON; no direct network fallback was attempted."); }
    const { body, bodyText, bodyBytes, bodyStream, ...rest } = options;
    return { request, options: { ...rest, bodyBytes: bytes } };
  }
  const catalog = createApiCatalogClient({ request: publicRequest, openWebSocket, requestExternal, openExternalWebSocket,
    onVerifiedCatalog: (snapshot, identity) => rememberDeliveryDescriptor(configPath, snapshot, identity, session?.config?.managerGuid || config?.managerGuid),
    cachedDelivery: networkTransport ? undefined : async (operationId, options) => {
      const snapshot = readDeliveryDescriptor(configPath, operationId);
      if (!snapshot) return undefined;
      const normalized = await readAgentJsonBody(options);
      return normalized.request?.action === "send" ? { catalog: snapshot, options: normalized.options } : undefined;
    } });
  return { request: publicRequest, invoke, upload, download, catalog, invokeOperation: catalog.invokeOperation, openOperation: catalog.openOperation };
}

export function createManagerClient(options) { return buildManagerClient(options); }
/** @internal The committed delivery owner alone uses this non-queuing transport. */
export function createManagerTransport(options) { return buildManagerClient(options, true); }
