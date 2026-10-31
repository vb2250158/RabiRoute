import type { ServerResponse } from "node:http";
import { ApiContractError, type ApiOperationStream, type ApiResponseContract, type CompiledApiOperation } from "./apiOperationContract.js";

function frameBytes(operation: CompiledApiOperation, descriptor: ApiResponseContract, frame: unknown): Uint8Array {
  const contract = descriptor.stream!;
  const fail = (code: string): never => { throw new ApiContractError(500, code, "response.stream", operation.contract.operationId, true); };
  let bytes: Uint8Array;
  if (contract.framing === "bytes") {
    if (!(frame instanceof Uint8Array)) return fail("API_STREAM_FRAME_INVALID");
    if (frame.byteLength > contract.maxFrameBytes) return fail("API_STREAM_FRAME_TOO_LARGE");
    bytes = Buffer.from(frame); // Owners may reuse their read buffer after yielding.
  } else {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || ![Object.prototype, null].includes(Object.getPrototypeOf(frame))) return fail("API_STREAM_FRAME_INVALID");
    const value = frame as Record<string, unknown>;
    if (!Object.keys(value).length || Object.keys(value).some(key => !["event", "id", "retry", "data", "comment"].includes(key))) return fail("API_STREAM_FRAME_INVALID");
    for (const key of ["event", "id", "comment"]) {
      if (value[key] !== undefined && (typeof value[key] !== "string" || /[\r\n\0]/.test(value[key] as string))) return fail("API_STREAM_FRAME_INVALID");
    }
    if (value.retry !== undefined && (!Number.isSafeInteger(value.retry) || Number(value.retry) < 0)) return fail("API_STREAM_FRAME_INVALID");
    if (!operation.streamValidators.get(descriptor)?.(frame)) return fail("API_STREAM_FRAME_SCHEMA_INVALID");
    const lines: string[] = [];
    if (value.comment !== undefined) lines.push(`: ${value.comment}`);
    if (value.retry !== undefined) lines.push(`retry: ${value.retry}`);
    if (value.id !== undefined) lines.push(`id: ${value.id}`);
    if (value.event !== undefined) lines.push(`event: ${value.event}`);
    if (Object.prototype.hasOwnProperty.call(value, "data")) {
      const json = JSON.stringify(value.data);
      if (json === undefined) return fail("API_STREAM_FRAME_INVALID");
      lines.push(`data: ${json}`);
    }
    bytes = Buffer.from(lines.join("\n") + "\n\n", "utf8");
  }
  if (bytes.byteLength > contract.maxFrameBytes) return fail("API_STREAM_FRAME_TOO_LARGE");
  return bytes;
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off("drain", drained); response.off("close", closed); response.off("error", failed); signal.removeEventListener("abort", aborted); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("API stream closed.")); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    response.once("drain", drained); response.once("close", closed); response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (response.destroyed || response.writableEnded) closed();
  });
}

function cancelOwner(source: ApiOperationStream) {
  let pending: Promise<void> | undefined;
  return (reason: unknown): Promise<void> => {
    if (pending) return pending;
    let resolve!: () => void, reject!: (error: unknown) => void;
    pending = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Install the promise before invoking an owner that may abort its signal reentrantly.
    try { Promise.resolve(source.cancel(reason)).then(resolve, reject); } catch (error) { reject(error); }
    return pending;
  };
}

async function joinCancellation(cancelled: Promise<void>, iterator: AsyncIterator<unknown>, pendingNext?: Promise<IteratorResult<unknown>>): Promise<void> {
  const drained = (async () => {
    let next = pendingNext ? await pendingNext : await iterator.next();
    while (!next.done) next = await iterator.next();
  })();
  // Cancellation may itself await the iterator's finally block. Drive both to completion.
  const results = await Promise.allSettled([cancelled, drained]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

/** Retire an accepted stream even when response failure happens before its writer starts. */
export async function cancelApiOperationStream(source: ApiOperationStream, reason: unknown): Promise<void> {
  const cancelled = cancelOwner(source)(reason);
  let iterator: AsyncIterator<unknown>;
  try { iterator = source.frames[Symbol.asyncIterator](); }
  catch (error) { await Promise.allSettled([cancelled]); throw error; }
  await joinCancellation(cancelled, iterator);
}

/** Consumes at most one frame ahead; a lease remains held until owner cancellation and iterator cleanup finish. */
export async function writeApiOperationStream(operation: CompiledApiOperation, descriptor: ApiResponseContract, source: ApiOperationStream,
  response: ServerResponse, options: { signal: AbortSignal; assertAuthority(): void }): Promise<void> {
  let iterator: AsyncIterator<unknown> | undefined;
  const signal = source.signal ? AbortSignal.any([options.signal, source.signal]) : options.signal;
  let cancellation: Promise<void> | undefined;
  let rejected!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejected = reject; });
  void interrupted.catch(() => undefined);
  const beginCancellation = cancelOwner(source);
  const cancel = (reason: unknown) => cancellation ??= beginCancellation(reason);
  const aborted = () => { void cancel(signal.reason).catch(() => undefined); rejected(signal.reason); };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  let completed = false;
  let pendingNext: Promise<IteratorResult<unknown>> | undefined;
  let total = 0;
  try {
    iterator = source.frames[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted(); options.assertAuthority();
      pendingNext = Promise.resolve(iterator.next());
      const next = await Promise.race([pendingNext, interrupted]);
      pendingNext = undefined;
      signal.throwIfAborted(); options.assertAuthority();
      if (next.done) { completed = true; break; }
      const bytes = frameBytes(operation, descriptor, next.value);
      total += bytes.byteLength;
      if (!Number.isSafeInteger(total) || descriptor.stream!.maxBytes !== undefined && total > descriptor.stream!.maxBytes!) {
        throw new ApiContractError(500, "API_STREAM_TOO_LARGE", "response.stream", operation.contract.operationId, true);
      }
      if (response.destroyed || response.writableEnded) throw new Error("API stream closed.");
      if (!response.write(bytes)) await waitForDrain(response, signal);
    }
    const length = response.getHeader("content-length");
    if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== total)) {
      throw new ApiContractError(500, "API_STREAM_LENGTH_MISMATCH", "response.stream", operation.contract.operationId, true);
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!completed) {
      // cancel must unblock next() and terminate the producer. A pending next()
      // may already have entered a yielding finally; return() at that point can
      // skip its remaining cleanup. Drain naturally to EOF without emitting.
      const cancelled = cancel(signal.reason);
      if (iterator) await joinCancellation(cancelled, iterator, pendingNext);
      else await cancelled;
    }
  }
}
