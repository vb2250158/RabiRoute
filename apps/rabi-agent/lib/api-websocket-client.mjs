import { WebSocket } from "ws";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

function failure(code, statusCode = 0) {
  const error = new Error(`Manager WebSocket failed (${code}); inspect original state before reconnecting or repeating a command.`);
  error.code = code; error.statusCode = statusCode; return error;
}

/** Transport only: no protocol login, reconnect, task dispatch or business replay. */
export async function openApiWebSocket({ url, headers, contract, onMessage, onOpen, onClose, signal, timeoutMs = 30_000, verifyIdentity,
  maxMessageBytes: clientMaxMessageBytes, maxBufferedBytes: clientMaxBufferedBytes, protocols, drainOnRemoteClose = false }) {
  const descriptor = contract.websocket;
  const passthrough = descriptor?.framing === "passthrough";
  // A transparent proxy has no aggregate message ceiling. These are local
  // consumer budgets, not a new server limit or a remote feature permission.
  const maxMessageBytes = passthrough ? clientMaxMessageBytes ?? 100 * 1024 * 1024 : descriptor?.maxMessageBytes;
  const maxBufferedBytes = passthrough ? clientMaxBufferedBytes ?? 2 * maxMessageBytes : descriptor?.maxBufferedBytes;
  if (contract.transport !== "websocket" || contract.method !== "GET" || !descriptor
    || !["json", "bytes", "passthrough"].includes(descriptor.framing)
    || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1
    || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < maxMessageBytes
    || passthrough && (!descriptor.wire || [descriptor.wire.dataFrameBytes, descriptor.wire.streamWindowBytes, descriptor.wire.maxConcurrentStreams].some(value => !Number.isSafeInteger(value) || value < 1)
      || descriptor.wire.dataFrameBytes > descriptor.wire.streamWindowBytes || descriptor.maxMessageBytes !== undefined || descriptor.maxBufferedBytes !== undefined)
    || typeof onMessage !== "function" || typeof verifyIdentity !== "function" || typeof drainOnRemoteClose !== "boolean"
    || onOpen !== undefined && typeof onOpen !== "function" || onClose !== undefined && typeof onClose !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw failure("UNSUPPORTED_CONTRACT");
  if (protocols !== undefined && (!Array.isArray(protocols) || protocols.some(value => typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value)) || new Set(protocols).size !== protocols.length)) throw failure("INVALID_PROTOCOLS");
  const closeGraceMs = descriptor.closeGraceMs ?? 2000;
  if (!Number.isSafeInteger(closeGraceMs) || closeGraceMs < 1 || closeGraceMs > 2_147_483_647) throw failure("UNSUPPORTED_CONTRACT");
  let incoming, outgoing;
  try {
    const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true }); addFormats(ajv);
    if (descriptor.framing === "json") {
      if (descriptor.incomingSchema === undefined || descriptor.outgoingSchema === undefined) throw new Error();
      // Directions in discovery are relative to the server owner.
      outgoing = ajv.compile(descriptor.incomingSchema); incoming = ajv.compile(descriptor.outgoingSchema);
    } else if (descriptor.incomingSchema !== undefined || descriptor.outgoingSchema !== undefined) throw new Error();
  } catch { throw failure("UNSUPPORTED_SCHEMA"); }
  signal?.throwIfAborted();
  const controller = new AbortController();
  let socket, channel, opened = false, ready = false, openingComplete = false, finished = false, closing = false, errorCode, closeTimer;
  let settleOpen, rejectOpen, resolveClosed, openingWork;
  const opening = new Promise((resolve, reject) => { settleOpen = resolve; rejectOpen = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const queue = []; let queuedBytes = 0, consuming;
  const pendingSends = new Set();
  const events = new EventTarget();
  const stop = (code, reason, error) => {
    if (error) errorCode ??= error;
    if (closing) {
      if (error) { controller.abort(); queue.length = 0; queuedBytes = 0; }
      return closed;
    }
    closing = true; controller.abort(); queue.length = 0; queuedBytes = 0;
    clearTimeout(deadline);
    if (socket?.readyState === WebSocket.OPEN) socket.close(code, reason);
    else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    closeTimer = setTimeout(() => socket?.terminate(), closeGraceMs); closeTimer.unref?.();
    return closed;
  };
  const drain = () => {
    if (!ready || closing || consuming) return;
    consuming = (async () => {
      while (!closing && queue.length) {
        const item = queue.shift();
        try { await onMessage(item.value, { signal: controller.signal, binary: item.binary }); }
        finally { queuedBytes = Math.max(0, queuedBytes - item.bytes); }
      }
    })().catch(() => { stop(1011, "Message consumer failed", "CONSUMER_FAILED"); }).finally(() => {
      consuming = undefined;
      if (!closing && ready) { if (queue.length) drain(); else socket.resume(); }
    });
  };
  const abort = () => stop(1000, "Cancelled", "CANCELLED");
  const deadline = setTimeout(() => stop(1000, "Opening deadline", "OPEN_TIMEOUT"), timeoutMs);
  try {
    socket = new WebSocket(url, protocols ?? [], { headers, followRedirects: false, maxPayload: maxMessageBytes, perMessageDeflate: false });
    channel = Object.freeze({ closed,
      get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
      get protocol() { return socket.protocol; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      send(data) { void channel.sendAsync(data); },
      sendAsync(data) {
        if (!ready || closing || socket.readyState !== WebSocket.OPEN) throw failure("CLOSED");
        let bytes;
        if (descriptor.framing === "json") {
          if (typeof data !== "string") throw failure("JSON_TEXT_REQUIRED");
          bytes = Buffer.byteLength(data);
        } else {
          if (!(data instanceof Uint8Array) && !(passthrough && typeof data === "string")) throw failure("BYTES_REQUIRED");
          bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        }
        if (bytes > maxMessageBytes || socket.bufferedAmount + bytes > maxBufferedBytes) {
          stop(1009, "Outgoing capacity exceeded", "CAPACITY_EXCEEDED"); throw failure("CAPACITY_EXCEEDED");
        }
        if (descriptor.framing === "json") {
          let value; try { value = JSON.parse(data); } catch { throw failure("INVALID_JSON"); }
          if (!outgoing(value)) throw failure("INVALID_OUTGOING_FRAME");
        }
        let completed, failed;
        const sent = new Promise((resolve, reject) => { completed = resolve; failed = reject; });
        pendingSends.add(sent);
        void sent.then(() => pendingSends.delete(sent), () => pendingSends.delete(sent));
        const finish = error => {
          if (error) { stop(1011, "Send failed", "TRANSPORT"); failed(failure("TRANSPORT")); }
          else completed();
        };
        try { socket.send(data, finish); } catch (error) { finish(error); }
        return sent;
      },
      sendJson(value) { if (descriptor.framing !== "json" && !passthrough) throw failure("JSON_NOT_SUPPORTED"); channel.send(JSON.stringify(value)); },
      sendJsonAsync(value) { if (descriptor.framing !== "json" && !passthrough) throw failure("JSON_NOT_SUPPORTED"); return channel.sendAsync(JSON.stringify(value)); },
      close(code = 1000, reason = "Client closed") {
        if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw failure("INVALID_CLOSE_CODE");
        if (typeof reason !== "string" || Buffer.byteLength(reason) > 123) throw failure("INVALID_CLOSE_REASON");
        stop(code, reason);
      }
    });
    socket.on("error", () => { errorCode ??= "TRANSPORT"; });
    socket.on("unexpected-response", (_request, response) => {
      errorCode = response.statusCode === 409 ? "API_CONTRACT_CHANGED" : "UPGRADE_REJECTED";
      rejectOpen(failure(errorCode, response.statusCode)); response.resume(); socket.terminate();
    });
    socket.on("message", (data, binary) => {
      if (closing) return;
      socket.pause();
      try {
        const bytes = data.byteLength;
        if (descriptor.framing === "bytes" && !binary || bytes > maxMessageBytes || queuedBytes + bytes > maxBufferedBytes) throw failure("CAPACITY_EXCEEDED");
        const value = descriptor.framing === "json" ? JSON.parse(data.toString("utf8")) : passthrough && !binary ? data.toString("utf8") : Buffer.from(data);
        if (incoming && !incoming(value)) throw failure("INVALID_INCOMING_FRAME");
        queue.push({ value, bytes, binary }); queuedBytes += bytes; drain();
      } catch { stop(1009, "Invalid or oversized frame", "INVALID_INCOMING_FRAME"); }
    });
    socket.once("open", () => {
      opened = true; socket.pause();
      openingWork = (async () => {
        await verifyIdentity(controller.signal);
        if (closing || signal?.aborted || socket.readyState !== WebSocket.OPEN) throw failure("CANCELLED");
        ready = true;
        await onOpen?.(channel, { signal: controller.signal });
        if (closing || socket.readyState !== WebSocket.OPEN) throw failure("CLOSED");
        openingComplete = true;
        clearTimeout(deadline); settleOpen(channel); drain();
        if (!consuming && !queue.length) socket.resume();
      })().catch(() => { stop(1000, "Opening verification failed", errorCode ?? "IDENTITY_OR_OPEN_FAILED"); });
    });
    socket.once("close", (code, reason) => {
      if (finished) return;
      const remoteEof = drainOnRemoteClose && code === 1000 && !closing && !errorCode && openingComplete && !signal?.aborted;
      finished = true; closing = true;
      clearTimeout(deadline); clearTimeout(closeTimer);
      if (!remoteEof) { controller.abort(); queue.length = 0; queuedBytes = 0; }
      rejectOpen(failure(errorCode ?? (opened ? "CLOSED_BEFORE_READY" : "TRANSPORT")));
      void (async () => {
        // The original consumer owns cleanup; closed must not outrun it.
        await openingWork; await consuming;
        await Promise.allSettled([...pendingSends]);
        // Normal remote EOF retains every already validated frame. Cancellation
        // still interrupts immediately; a successful capture cannot drop a tail.
        if (remoteEof && !errorCode && !signal?.aborted) {
          while (queue.length && !errorCode && !signal?.aborted) {
            const item = queue.shift(); queuedBytes -= item.bytes;
            try { await onMessage(item.value, { signal: controller.signal, binary: item.binary }); }
            catch { errorCode ??= "CONSUMER_FAILED"; }
          }
        }
        controller.abort(); queue.length = 0; queuedBytes = 0;
        signal?.removeEventListener("abort", abort);
        const result = { code, reason: reason.toString(), ...(errorCode ? { errorCode } : {}) };
        try { await onClose?.(result); } catch { result.errorCode ??= "CLOSE_CONSUMER_FAILED"; }
        resolveClosed(Object.freeze(result));
        events.dispatchEvent(new Event("close"));
      })();
    });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  } catch {
    clearTimeout(deadline); signal?.removeEventListener("abort", abort); socket?.terminate(); throw failure("TRANSPORT");
  }
  try { return await opening; }
  catch (error) { await closed; throw error; }
}
