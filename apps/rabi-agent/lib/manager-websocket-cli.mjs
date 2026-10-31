import { open, lstat, link, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function failure(code) { return Object.assign(new Error("CLI WebSocket exchange was not confirmed."), { code }); }

/** JSONL is a CLI envelope, not a second application protocol or endpoint map. */
async function* inputFrames(source, maxLineBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  const parse = value => {
    let frame;
    try { frame = JSON.parse(value); } catch { throw failure("WS_INPUT_INVALID"); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw failure("WS_INPUT_INVALID");
    return frame;
  };
  try {
    for await (const chunk of source) {
      const decoded = decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
      for (const part of decoded.split(/(?<=\n)/)) {
        line += part;
        if (Buffer.byteLength(line) > maxLineBytes) throw failure("WS_INPUT_TOO_LARGE");
        if (line.endsWith("\n")) { if (line.trim()) yield parse(line); line = ""; }
      }
    }
    line += decoder.decode();
    if (Buffer.byteLength(line) > maxLineBytes) throw failure("WS_INPUT_TOO_LARGE");
    if (line.trim()) yield parse(line);
  } catch (error) {
    if (error?.code?.startsWith("WS_INPUT_")) throw error;
    throw failure("WS_INPUT_FAILED");
  }
}

async function sendFrame(channel, frame) {
  const allowed = frame.type === "close" ? ["type", "code", "reason"] : ["type", "data"];
  if (Object.keys(frame).some(key => !allowed.includes(key))) throw failure("WS_INPUT_INVALID");
  if (frame.type === "json" && Object.hasOwn(frame, "data")) await channel.sendJsonAsync(frame.data);
  else if (frame.type === "text" && typeof frame.data === "string") await channel.sendAsync(frame.data);
  else if (frame.type === "binary" && typeof frame.data === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.toString("base64") !== frame.data) throw failure("WS_INPUT_INVALID");
    await channel.sendAsync(bytes);
  } else if (frame.type === "close") { channel.close(frame.code, frame.reason); return true; }
  else throw failure("WS_INPUT_INVALID");
  return false;
}

/** One explicitly consumed connection. Owned callbacks and stdin finish before output is committed. */
export async function runManagerWebSocketCommand(client, operationId, {
  outputPath, inputStream, path: pathValues, query, headers, signal, timeoutMs = 30_000,
  maxOutputBytes = 256 * 1024 * 1024, maxMessageBytes, maxBufferedBytes, protocols,
  redact = value => value, protectedCredential
}) {
  if (typeof outputPath !== "string" || !outputPath.trim() || outputPath.includes("\0")) throw new Error("WebSocket CLI requires --output FILE for JSONL frames.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("WebSocket CLI limits must be positive supported integers.");
  if (inputStream && (typeof inputStream[Symbol.asyncIterator] !== "function" || typeof inputStream.destroy !== "function")) throw new Error("WebSocket stdin requires an owned readable stream.");
  const finalPath = path.resolve(outputPath), temporaryPath = path.join(path.dirname(finalPath), `.rabi-ws-${randomUUID()}.partial`);
  let handle, created = false, committed = false, channel, closeResult, errorCode, timer;
  let inputWork, stoppingInput = false, inputComplete = !inputStream;
  let framesSent = 0, framesReceived = 0, outputBytes = 0;
  const hash = createHash("sha256"), deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const stopInput = () => { stoppingInput = true; if (inputStream && inputWork && !inputComplete) inputStream.destroy(); };
  const identityMatches = (expected, current) => expected.applicationGenerationId === current?.applicationGenerationId && expected.managerInstanceId === current?.managerInstanceId;
  try {
    combined.throwIfAborted();
    try { await lstat(finalPath); throw failure("OUTPUT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    handle = await open(temporaryPath, "wx", 0o600); created = true;
    timer = setTimeout(() => deadline.abort(failure("WS_DEADLINE_EXCEEDED")), timeoutMs);
    const catalog = await client.catalog.refresh({ signal: combined });
    const entry = catalog.operations.find(value => value.id === operationId || value.contract.aliases?.includes(operationId));
    if (entry?.contract.transport !== "websocket") throw failure("WEBSOCKET_CONTRACT_REQUIRED");
    const descriptor = entry.contract.websocket;
    const messageBudget = descriptor.framing === "passthrough" ? maxMessageBytes ?? 100 * 1024 * 1024 : descriptor.maxMessageBytes;
    const lineBudget = 2 * messageBudget + 4096;
    if (!Number.isSafeInteger(lineBudget) || lineBudget < 1) throw failure("UNSUPPORTED_CONTRACT");
    const verifyOriginalIdentity = async currentSignal => {
      const receipt = await client.request("GET", "/meta", { signal: currentSignal, replaySafe: false });
      if (!receipt.ok || receipt.uncertain || receipt.identityChanged || !identityMatches(catalog, receipt.identity)) throw failure("IDENTITY_CHANGED");
    };
    channel = await client.openOperation(operationId, { path: pathValues, query, headers, signal: combined, timeoutMs,
      maxMessageBytes, maxBufferedBytes, protocols, drainOnRemoteClose: true,
      onOpen: (_channel, context) => verifyOriginalIdentity(context.signal),
      async onMessage(value, context) {
        try {
          combined.throwIfAborted();
          let frame;
          if (descriptor.framing === "json") frame = { type: "json", data: redact(value) };
          else if (context.binary) {
            const bytes = Buffer.from(value);
            if (protectedCredential && [protectedCredential, encodeURIComponent(protectedCredential)].some(secret => bytes.includes(Buffer.from(secret)))) throw failure("CREDENTIAL_REFLECTION");
            frame = { type: "binary", data: bytes.toString("base64") };
          } else frame = { type: "text", data: redact(value) };
          const bytes = Buffer.from(JSON.stringify(frame) + "\n");
          if (outputBytes + bytes.length > maxOutputBytes) throw failure("WS_OUTPUT_TOO_LARGE");
          let offset = 0;
          while (offset < bytes.length) {
            combined.throwIfAborted();
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw failure("OUTPUT_FAILED");
            offset += bytesWritten;
          }
          hash.update(bytes); outputBytes += bytes.length; framesReceived++;
        } catch (error) {
          errorCode = typeof error.code === "string" ? error.code : combined.aborted ? "CANCELLED" : "OUTPUT_FAILED";
          throw failure(errorCode);
        }
      },
      async onClose() { stopInput(); await inputWork; }
    });
    if (inputStream) inputWork = (async () => {
      try {
        for await (const frame of inputFrames(inputStream, lineBudget)) {
          if (stoppingInput) return;
          combined.throwIfAborted();
          if (await sendFrame(channel, frame)) { inputComplete = true; return; }
          framesSent++;
        }
        inputComplete = true; // EOF stops sending; it does not invent a business completion or close the peer.
      } catch (error) {
        if (!stoppingInput) { errorCode = error.code ?? "WS_INPUT_FAILED"; channel.close(); }
      }
    })();
    closeResult = await channel.closed;
    if (errorCode || closeResult.errorCode || closeResult.code !== 1000) throw failure(errorCode ?? closeResult.errorCode ?? "WS_CONNECTION_INTERRUPTED");
    combined.throwIfAborted();
    await verifyOriginalIdentity(combined);
    combined.throwIfAborted();
    await handle.sync(); await handle.close(); handle = undefined;
    combined.throwIfAborted(); await link(temporaryPath, finalPath); committed = true;
    return redact({ statusCode: 101, ok: true, uncertain: false, noReplay: true, transport: "websocket", operationId: entry.id,
      framesSent, framesReceived, inputComplete, outputBytes, outputCommitted: true, path: finalPath, sha256: hash.digest("hex"), close: closeResult,
      identity: { applicationGenerationId: catalog.applicationGenerationId, managerInstanceId: catalog.managerInstanceId }, businessOutcome: "not-evaluated" });
  } catch (error) {
    return redact({ statusCode: channel ? 101 : 0, ok: false, uncertain: Boolean(channel), noReplay: true, transport: "websocket", operationId,
      framesSent, framesReceived, inputComplete, outputBytes, outputCommitted: committed, transportError: error.code ?? "CLI_WEBSOCKET_FAILED",
      ...(closeResult ? { close: closeResult } : {}), businessOutcome: "not-evaluated" });
  } finally {
    clearTimeout(timer); stopInput();
    if (channel) { channel.close(); await channel.closed; }
    await inputWork;
    if (handle) await handle.close();
    if (created) await unlink(temporaryPath);
  }
}
