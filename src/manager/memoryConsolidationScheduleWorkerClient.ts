import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MemoryConsolidationScheduleEvaluation } from "./memoryConsolidationScheduler.js";

type ChildResult =
  | { ok: true; evaluation: MemoryConsolidationScheduleEvaluation }
  | { ok: false };

type ChildDiagnosticStream = Readonly<{
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  destroy(): void;
}>;

export type MemoryConsolidationScheduleChild = {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout?: ChildDiagnosticStream | null;
  readonly stderr?: ChildDiagnosticStream | null;
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
  unref(): void;
};

export type MemoryConsolidationScheduleChildFactory = (
  roleDir: string
) => MemoryConsolidationScheduleChild;

export type MemoryConsolidationScheduleEvaluationOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationTimeoutMs?: number;
  childFactory?: MemoryConsolidationScheduleChildFactory;
}>;

type ScheduleEvaluationError = Error & {
  code?: string;
  retryable?: boolean;
};

const unconfirmedTerminations = new Set<object>();

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function codedError(message: string, code: string, retryable?: boolean): ScheduleEvaluationError {
  return Object.assign(new Error(message), {
    code,
    ...(retryable === undefined ? {} : { retryable })
  });
}

function createScheduleEvaluationChild(roleDir: string): MemoryConsolidationScheduleChild {
  const childPath = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts")
      ? "./memoryConsolidationScheduleWorker.ts"
      : "./memoryConsolidationScheduleWorker.js",
    import.meta.url
  ));
  return fork(childPath, [], {
    env: {
      ...process.env,
      RABIROUTE_MEMORY_CONSOLIDATION_SCHEDULE_INPUT: Buffer.from(
        JSON.stringify({ roleDir }),
        "utf8"
      ).toString("base64url")
    },
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  }) as MemoryConsolidationScheduleChild;
}

function waitForExit(
  child: MemoryConsolidationScheduleChild,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

async function terminateAndConfirm(
  child: MemoryConsolidationScheduleChild,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // The exit observation below remains the source of truth.
  }
  if (await waitForExit(child, timeoutMs)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    // A failed force signal is reported as an unconfirmed termination below.
  }
  return waitForExit(child, timeoutMs);
}

function quarantineUnconfirmedChild(child: MemoryConsolidationScheduleChild): void {
  const token = {};
  unconfirmedTerminations.add(token);
  child.once("exit", () => unconfirmedTerminations.delete(token));
  try {
    if (child.connected) child.disconnect();
  } catch {
    // Detaching is best-effort; the Host Job remains the final process-tree fence.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

export function evaluateMemoryConsolidationSchedule(
  roleDir: string,
  options: MemoryConsolidationScheduleEvaluationOptions = {}
): Promise<MemoryConsolidationScheduleEvaluation> {
  if (options.signal?.aborted) {
    return Promise.reject(
      options.signal.reason
        ?? new DOMException("Memory schedule evaluation aborted.", "AbortError")
    );
  }
  if (unconfirmedTerminations.size > 0) {
    return Promise.reject(codedError(
      "Memory schedule evaluation is fenced because a previous child termination is not confirmed.",
      "MEMORY_SCHEDULE_CHILD_TERMINATION_UNCONFIRMED",
      false
    ));
  }

  const childFactory = options.childFactory ?? createScheduleEvaluationChild;
  let child: MemoryConsolidationScheduleChild;
  try {
    child = childFactory(roleDir);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
    const terminationTimeoutMs = positiveInteger(options.terminationTimeoutMs, 5_000);
    let diagnosticBytes = 0;
    let terminalCause: "abort" | "error" | "message" | "timeout" | undefined;
    let result: ChildResult | undefined;
    let terminalError: unknown;
    let settled = false;
    let terminationFlight: Promise<boolean> | undefined;

    const captureDiagnostic = (chunk: Buffer | string): void => {
      const byteLength = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(chunk, "utf8");
      diagnosticBytes = Math.min(Number.MAX_SAFE_INTEGER, diagnosticBytes + byteLength);
    };
    child.stdout?.on("data", captureDiagnostic);
    child.stderr?.on("data", captureDiagnostic);

    const cleanup = (): void => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", captureDiagnostic);
      child.stderr?.off("data", captureDiagnostic);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (!result) {
        reject(new Error("Memory consolidation schedule child exited without a result."));
        return;
      }
      if (result.ok) resolve(result.evaluation);
      else reject(codedError(
        "Memory consolidation schedule inspection failed.",
        "MEMORY_SCHEDULE_INSPECTION_FAILED"
      ));
    };

    const terminateBeforeFinish = (): void => {
      if (terminationFlight) return;
      terminationFlight = terminateAndConfirm(child, terminationTimeoutMs);
      void terminationFlight.then(confirmed => {
        if (!confirmed) {
          quarantineUnconfirmedChild(child);
          terminalError = codedError(
            `Memory consolidation schedule child termination was not confirmed: pid=${child.pid ?? "unknown"}.`,
            "MEMORY_SCHEDULE_CHILD_TERMINATION_UNCONFIRMED",
            false
          );
        }
        finish();
      }).catch(error => {
        quarantineUnconfirmedChild(child);
        terminalError = codedError(
          `Memory consolidation schedule child termination failed: ${error instanceof Error ? error.message : String(error)}`,
          "MEMORY_SCHEDULE_CHILD_TERMINATION_UNCONFIRMED",
          false
        );
        finish();
      });
    };

    const abort = (): void => {
      if (settled || terminalCause === "abort" || terminalCause === "timeout") return;
      terminalCause = "abort";
      terminalError = options.signal?.reason
        ?? new DOMException("Memory schedule evaluation aborted.", "AbortError");
      terminateBeforeFinish();
    };

    const onMessage = (message: ChildResult): void => {
      if (settled || terminalCause !== undefined) return;
      terminalCause = "message";
      result = message;
      terminateBeforeFinish();
    };

    const onError = (error: Error): void => {
      if (settled || terminalCause === "abort" || terminalCause === "timeout") return;
      terminalCause = "error";
      terminalError = error;
      terminateBeforeFinish();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (terminalCause === undefined) {
        terminalError = new Error(
          `Memory consolidation schedule child exited without a result: code=${code ?? "none"}; signal=${signal ?? "none"}`
          + (diagnosticBytes > 0 ? `; diagnosticBytes=${diagnosticBytes}` : "")
        );
      }
      finish();
    };

    const deadline = setTimeout(() => {
      if (settled || terminalCause === "abort" || terminalCause === "timeout") return;
      terminalCause = "timeout";
      terminalError = codedError(
        `Memory schedule evaluation timed out after ${timeoutMs}ms.`,
        "ETIMEDOUT"
      );
      terminateBeforeFinish();
    }, timeoutMs);
    deadline.unref?.();

    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() => onExit(child.exitCode, child.signalCode));
    }
  });
}
