import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestBodyDeadlineOptions {
  normalMs?: number;
  uploadMs?: number;
  /** Set only after trusted source authorization and an exact PUT upload UUID route match. */
  isAuthorizedUpload: boolean;
}

/**
 * Bound body receipt, not response processing. Call after headers/authentication;
 * the caller owns route matching and authorization. Never consumes body bytes.
 * Returns an idempotent disposer for cancellation by the caller.
 */
export function guardRequestBodyDeadline(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestBodyDeadlineOptions = { isAuthorizedUpload: false }
): () => void {
  if (req.complete || req.readableEnded || req.destroyed || res.writableEnded || res.destroyed) return () => {};

  const durationMs = options.isAuthorizedUpload ? options.uploadMs ?? 1_800_000 : options.normalMs ?? 30_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
    throw new RangeError("Request body deadline must be a positive finite timer duration.");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    req.off("end", dispose);
    req.off("aborted", dispose);
    req.off("close", dispose);
    res.off("finish", onFinish);
    res.off("close", dispose);
  };

  const onFinish = () => {
    dispose();
    // An early response must not leave an unfinished body occupying a connection
    // until the server-wide upload ceiling. The response has already flushed.
    if (!req.complete && !req.readableEnded) req.socket.destroySoon();
  };

  timer = setTimeout(() => {
    dispose();
    // complete can become true before a paused consumer emits end.
    if (req.complete || req.readableEnded || req.destroyed || res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      // A response already in flight cannot be replaced with a valid 408.
      res.destroy();
      return;
    }
    const socket = req.socket;
    // Do not destroy the socket before the timeout response is flushed. Closing
    // afterwards aborts the unfinished consumer without adding a data listener.
    res.once("finish", () => socket.destroySoon());
    res.writeHead(408, { "Connection": "close", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Request body deadline exceeded.\n");
  }, durationMs);
  timer.unref();
  req.once("end", dispose);
  req.once("aborted", dispose);
  req.once("close", dispose);
  res.once("finish", onFinish);
  res.once("close", dispose);
  return dispose;
}
