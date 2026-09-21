import type http from "node:http";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";

type ReadHttpOptions<Result> = {
  read: (signal: AbortSignal) => Promise<Result>;
  respond: (data: Result) => void;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  /** Existing query/business failure status; worker unavailability is always 503. */
  errorStatus?: number;
};

/** Tie a bounded reader task to its HTTP caller; the pool owns worker termination. */
export function managerReadHttpResponse<Result>(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ReadHttpOptions<Result>
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => { if (!response.writableEnded) abort(); };
  const cleanup = () => { request.removeListener("aborted", abort); response.removeListener("close", closed); };
  request.once("aborted", abort);
  response.once("close", closed);
  if (request.aborted || response.destroyed) {
    abort();
    cleanup();
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return options.read(controller.signal);
    })
    .then(data => {
      if (controller.signal.aborted || response.destroyed) return;
      options.respond(data);
    })
    .catch(error => {
      if (controller.signal.aborted || response.destroyed) return;
      const unavailable = error instanceof ManagerReadWorkerError
        && ["busy", "timeout", "termination_unconfirmed"].includes(error.code);
      options.json(response, unavailable ? 503 : options.errorStatus ?? 400, {
        code: -1, message: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(cleanup);
}
