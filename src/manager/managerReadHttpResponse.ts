import type http from "node:http";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";

type ReadHttpOptions<Result> = {
  read: (signal: AbortSignal) => Promise<Result>;
  respond: (data: Result) => void;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  /** Existing query/business failure status; worker unavailability is always 503. */
  errorStatus?: number;
  /** Includes queue time and worker retirement, without waiting to send the error. */
  deadlineMs?: number;
};

/** Tie a bounded reader task to its HTTP caller; the pool owns worker termination. */
export function managerReadHttpResponse<Result>(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ReadHttpOptions<Result>
): Promise<void> {
  const controller = new AbortController();
  let deadlineExpired = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const abort = () => controller.abort();
  const closed = () => { if (!response.writableEnded) abort(); };
  const cleanup = () => { clearTimeout(deadlineTimer); request.removeListener("aborted", abort); response.removeListener("close", closed); };
  request.once("aborted", abort);
  response.once("close", closed);
  if (request.aborted || response.destroyed) {
    abort();
    cleanup();
    return Promise.resolve();
  }
  const read = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return options.read(controller.signal);
    });
  const deadline = new Promise<never>((_, reject) => {
    if (options.deadlineMs === undefined) return;
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      reject(new ManagerReadWorkerError("SEARCH_DEADLINE_EXCEEDED", "timeout"));
      controller.abort();
    }, options.deadlineMs);
  });
  return Promise.race([read, deadline])
    .then(data => {
      if (controller.signal.aborted || response.destroyed) return;
      options.respond(data);
    })
    .catch(error => {
      if (response.destroyed || (controller.signal.aborted && !deadlineExpired)) return;
      const unavailable = error instanceof ManagerReadWorkerError
        && ["busy", "timeout", "termination_unconfirmed"].includes(error.code);
      options.json(response, unavailable ? 503 : options.errorStatus ?? 400, {
        code: -1, message: error instanceof Error ? error.message : String(error),
        ...(deadlineExpired || (error instanceof ManagerReadWorkerError && error.code === "timeout") ? { errorCode: "SEARCH_DEADLINE_EXCEEDED" }
          : error instanceof Error && /^(MESSAGE_HISTORY_INDEX_[A-Z_]+|SEARCH_BUSY)/.test(error.message)
            ? { errorCode: error.message.match(/^[A-Z_]+/)![0] } : unavailable ? { errorCode: "SEARCH_BUSY" } : {})
      });
    })
    .finally(cleanup);
}
