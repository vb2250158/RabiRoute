import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

export type PlanStorageStartupLifecycleState = "idle" | "running" | "ready" | "degraded" | "stopping" | "stopped";

export type PlanStorageStartupLifecycleSnapshot = Readonly<{
  state: PlanStorageStartupLifecycleState;
  attempt: number;
  incidents: number;
  lastTransitionAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  nextRetryAt?: string;
  childPid?: number;
  lastError?: string;
  summary?: PlanStorageStartupGateSummary;
}>;

export type PlanStorageStartupAttempt = Readonly<{
  pid?: number;
  result: Promise<PlanStorageStartupGateSummary>;
  cancel(): Promise<void>;
}>;

class PlanStorageStartupAttemptError extends Error {
  constructor(message: string, readonly summary?: PlanStorageStartupGateSummary) {
    super(message);
    this.name = "PlanStorageStartupAttemptError";
  }
}

export type PlanStorageStartupLifecycleOptions = Readonly<{
  rolesRoot: string;
  readOnly: boolean;
  attemptTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  terminateTimeoutMs?: number;
  attemptFactory?: () => PlanStorageStartupAttempt;
  onStatus?: (snapshot: PlanStorageStartupLifecycleSnapshot) => void;
}>;

type StartupChildMessage =
  | Readonly<{ ok: true; summary: PlanStorageStartupGateSummary }>
  | Readonly<{ ok: false; error: string; summary?: PlanStorageStartupGateSummary }>;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export function createPlanStorageStartupAttempt(input: Readonly<{
  rolesRoot: string;
  readOnly: boolean;
  terminateTimeoutMs?: number;
}>): PlanStorageStartupAttempt {
  const childPath = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./planStorageStartupChild.ts" : "./planStorageStartupChild.js",
    import.meta.url
  ));
  const child = fork(childPath, [], {
    env: {
      ...process.env,
      RABIROUTE_PLAN_STORAGE_STARTUP_INPUT: Buffer.from(JSON.stringify({
        rolesRoot: input.rolesRoot,
        readOnly: input.readOnly
      }), "utf8").toString("base64url")
    },
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let diagnosticBytes = 0;
  const captureDiagnostic = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8");
    diagnosticBytes = Math.min(Number.MAX_SAFE_INTEGER, diagnosticBytes + bytes);
  };
  child.stdout?.on("data", captureDiagnostic);
  child.stderr?.on("data", captureDiagnostic);
  let settled = false;
  let cancelFlight: Promise<void> | undefined;
  const result = new Promise<PlanStorageStartupGateSummary>((resolve, reject) => {
    child.once("message", (message: StartupChildMessage) => {
      if (settled) return;
      settled = true;
      if (message?.ok === true) resolve(message.summary);
      else reject(new PlanStorageStartupAttemptError(
        "Plan storage startup gate failed.",
        message?.summary
      ));
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Plan storage startup child process failed."));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `Plan storage startup child exited without a result: code=${code ?? "none"}; signal=${signal ?? "none"}`
        + (diagnosticBytes > 0 ? `; diagnosticBytes=${diagnosticBytes}` : "")
      ));
    });
  });
  return Object.freeze({
    pid: child.pid,
    result,
    cancel(): Promise<void> {
      if (cancelFlight) return cancelFlight;
      cancelFlight = (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        if (await waitForExit(child, positiveInteger(input.terminateTimeoutMs, 5_000))) return;
        child.kill("SIGKILL");
        if (!await waitForExit(child, positiveInteger(input.terminateTimeoutMs, 5_000))) {
          throw new Error(`Plan storage startup child did not exit after termination: pid=${child.pid ?? "unknown"}`);
        }
      })();
      return cancelFlight;
    }
  });
}

export class PlanStorageStartupLifecycle {
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly attemptFactory: () => PlanStorageStartupAttempt;
  private currentAttempt: { value: PlanStorageStartupAttempt; settled: boolean; timeout?: NodeJS.Timeout } | undefined;
  private cancellationFlight: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopFlight: Promise<void> | undefined;
  private active = false;
  private readonly readyListeners = new Set<(summary: PlanStorageStartupGateSummary) => void>();
  private runtimeSnapshot: PlanStorageStartupLifecycleSnapshot;

  constructor(private readonly options: PlanStorageStartupLifecycleOptions) {
    this.attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 15 * 60_000);
    this.retryBaseMs = positiveInteger(options.retryBaseMs, 5_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(options.retryMaxMs, 60_000));
    this.attemptFactory = options.attemptFactory ?? (() => createPlanStorageStartupAttempt({
      rolesRoot: options.rolesRoot,
      readOnly: options.readOnly,
      terminateTimeoutMs: options.terminateTimeoutMs
    }));
    this.runtimeSnapshot = Object.freeze({
      state: "idle",
      attempt: 0,
      incidents: 0,
      lastTransitionAt: new Date().toISOString()
    });
  }

  snapshot(): PlanStorageStartupLifecycleSnapshot {
    return Object.freeze({
      ...this.runtimeSnapshot,
      summary: this.runtimeSnapshot.summary ? { ...this.runtimeSnapshot.summary, failures: [...this.runtimeSnapshot.summary.failures] } : undefined
    });
  }

  onReady(listener: (summary: PlanStorageStartupGateSummary) => void): () => void {
    this.readyListeners.add(listener);
    if (this.runtimeSnapshot.state === "ready" && this.runtimeSnapshot.summary) {
      queueMicrotask(() => {
        if (this.readyListeners.has(listener) && this.runtimeSnapshot.summary) listener(this.runtimeSnapshot.summary);
      });
    }
    return () => this.readyListeners.delete(listener);
  }

  start(): void {
    if (this.active || this.runtimeSnapshot.state === "ready" || this.runtimeSnapshot.state === "stopped") return;
    this.active = true;
    this.startAttempt();
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    if (this.runtimeSnapshot.state === "stopped") return Promise.resolve();
    this.stopFlight = this.stopOnce();
    return this.stopFlight;
  }

  private async stopOnce(): Promise<void> {
    this.active = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.transition({ state: "stopping", incidents: 0, nextRetryAt: undefined });
    const current = this.currentAttempt;
    if (current) {
      current.settled = true;
      if (current.timeout) clearTimeout(current.timeout);
      this.currentAttempt = undefined;
      this.cancellationFlight = this.trackCancellation(current.value.cancel());
    }
    if (this.cancellationFlight) await this.cancellationFlight;
    this.readyListeners.clear();
    this.transition({ state: "stopped", incidents: 0, childPid: undefined, deadlineAt: undefined, nextRetryAt: undefined });
  }

  private trackCancellation(cancellation: Promise<void>): Promise<void> {
    const tracked = Promise.resolve(cancellation).finally(() => {
      if (this.cancellationFlight === tracked) this.cancellationFlight = undefined;
    });
    return tracked;
  }

  private transition(patch: Partial<PlanStorageStartupLifecycleSnapshot>): void {
    this.runtimeSnapshot = Object.freeze({
      ...this.runtimeSnapshot,
      ...patch,
      lastTransitionAt: new Date().toISOString()
    });
    this.options.onStatus?.(this.snapshot());
  }

  private startAttempt(): void {
    if (!this.active) return;
    const attemptNumber = this.runtimeSnapshot.attempt + 1;
    let attempt: PlanStorageStartupAttempt;
    try {
      attempt = this.attemptFactory();
    } catch {
      this.failAttempt(new Error("Plan storage startup child failed to start."), attemptNumber);
      return;
    }
    const startedAt = new Date();
    const token = { value: attempt, settled: false, timeout: undefined as NodeJS.Timeout | undefined };
    this.currentAttempt = token;
    this.transition({
      state: "running",
      attempt: attemptNumber,
      incidents: 0,
      startedAt: startedAt.toISOString(),
      completedAt: undefined,
      deadlineAt: new Date(startedAt.getTime() + this.attemptTimeoutMs).toISOString(),
      nextRetryAt: undefined,
      childPid: attempt.pid,
      lastError: undefined
    });
    token.timeout = setTimeout(() => {
      if (token.settled) return;
      token.settled = true;
      this.currentAttempt = undefined;
      const cancellation = Promise.resolve().then(() => attempt.cancel())
        .then(() => this.failAttempt(new Error(`Plan storage startup attempt timed out after ${this.attemptTimeoutMs}ms.`), attemptNumber))
        .catch(error => this.failAttempt(error instanceof Error ? error : new Error(String(error)), attemptNumber));
      this.cancellationFlight = this.trackCancellation(cancellation);
    }, this.attemptTimeoutMs);
    token.timeout.unref();
    void attempt.result.then(summary => {
      if (token.settled) return;
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      this.currentAttempt = undefined;
      if (!this.active) return;
      this.active = false;
      this.transition({
        state: "ready",
        incidents: 0,
        completedAt: new Date().toISOString(),
        deadlineAt: undefined,
        childPid: undefined,
        lastError: undefined,
        summary
      });
      for (const listener of [...this.readyListeners]) listener(summary);
    }).catch(error => {
      if (token.settled) return;
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      this.currentAttempt = undefined;
      this.failAttempt(error instanceof Error ? error : new Error(String(error)), attemptNumber);
    });
  }

  private failAttempt(error: Error, attemptNumber: number): void {
    if (!this.active) return;
    const exponent = Math.max(0, Math.min(20, attemptNumber - 1));
    const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    const nextRetryAt = new Date(Date.now() + retryMs).toISOString();
    this.transition({
      state: "degraded",
      attempt: attemptNumber,
      incidents: 1,
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      childPid: undefined,
      lastError: error.message,
      nextRetryAt,
      summary: error instanceof PlanStorageStartupAttemptError ? error.summary : this.runtimeSnapshot.summary
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt();
    }, retryMs);
    this.retryTimer.unref();
  }
}
