import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { stopChildProcessTree } from "../runtime/windowsProcessTree.js";
import { managerReadWorkerOperation } from "../shared/performanceOperations.js";
import type {
  AgentAdapterCatalogWorkerRequest,
  AgentAdapterCatalogWorkerResponse,
  AgentAdapterCatalogWorkerTask
} from "./agentAdapterCatalogWorker.js";

export type AgentAdapterCatalogWorkerPoolOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};

export type AgentAdapterCatalogWorkerPoolStatus = {
  executionMode: "child_process";
  state: "accepting" | "cancelling" | "stopped";
  active: number;
  queued: number;
  workers: number;
  workerPids: number[];
  spawnedWorkers: number;
  globalActive: number;
  globalMaxConcurrency: number;
  maxConcurrency: number;
  maxQueue: number;
  timeoutMs: number;
};

export class AgentAdapterCatalogWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "timeout" | "aborted" | "worker_failed"
  ) {
    super(message);
    this.name = "AgentAdapterCatalogWorkerError";
  }
}

type PendingScan = {
  task: AgentAdapterCatalogWorkerTask;
  queuedAt: number;
  timeoutMs: number;
  settled: boolean;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type SharedScan = {
  key: string;
  pending: PendingScan;
  subscribers: number;
  completed: boolean;
};

type ActiveScan = {
  pending: PendingScan;
  requestId: string;
  startedAt: number;
  timer?: NodeJS.Timeout;
};

type WorkerSlot = {
  worker: ChildProcess;
  active: ActiveScan;
  closed: boolean;
};

function workerEntryPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./agentAdapterCatalogWorker.ts" : "./agentAdapterCatalogWorker.js",
    import.meta.url
  ));
}

function workerExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function unrefWorker(worker: ChildProcess): void {
  worker.unref();
  worker.channel?.unref?.();
}

function cancellationError(reason?: string): AgentAdapterCatalogWorkerError {
  return new AgentAdapterCatalogWorkerError(
    reason?.trim() || "Agent adapter catalog scan was cancelled.",
    "aborted"
  );
}

/**
 * The child process owns scan lifetime and process-tree cleanup. It is not a
 * security sandbox; only host-approved scanner code belongs in this worker.
 */
export class AgentAdapterCatalogWorkerPool {
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly queue: PendingScan[] = [];
  private readonly inFlight = new Map<string, SharedScan>();
  private readonly workers = new Set<WorkerSlot>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly terminations = new Set<Promise<void>>();
  private state: "accepting" | "cancelling" | "stopped" = "accepting";
  private active = 0;
  private spawnedWorkers = 0;
  private nextRequestId = 1;

  constructor(options: AgentAdapterCatalogWorkerPoolOptions = {}) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 1));
    this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 5 * 60_000));
  }

  query<T>(
    task: AgentAdapterCatalogWorkerTask,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.state !== "accepting") {
      return Promise.reject(cancellationError(
        this.state === "stopped"
          ? "Agent adapter catalog worker pool is stopped."
          : "Agent adapter catalog worker pool is cancelling active scans."
      ));
    }

    const key = JSON.stringify(task);
    let shared = this.inFlight.get(key);
    if (!shared) {
      const pending = this.enqueue(task, options.timeoutMs);
      shared = { key, pending, subscribers: 0, completed: false };
      const current = shared;
      this.inFlight.set(key, current);
      void pending.promise.then(
        () => this.completeShared(current),
        () => this.completeShared(current)
      );
    }
    return this.subscribe<T>(shared, options.signal);
  }

  status(): AgentAdapterCatalogWorkerPoolStatus {
    return {
      executionMode: "child_process",
      state: this.state,
      active: this.active,
      queued: this.queue.length,
      workers: this.workers.size,
      workerPids: [...this.workers]
        .map(slot => slot.worker.pid)
        .filter((pid): pid is number => typeof pid === "number"),
      spawnedWorkers: this.spawnedWorkers,
      globalActive: this.active,
      globalMaxConcurrency: this.maxConcurrency,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
      timeoutMs: this.timeoutMs
    };
  }

  async cancel(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.drain();
      return;
    }
    this.state = "cancelling";
    const error = cancellationError(reason);
    for (const pending of [...this.queue]) this.cancelPending(pending, error);
    for (const slot of [...this.workers]) this.cancelActive(slot, error);
    await this.drain();
    if (this.status().state !== "stopped") this.state = "accepting";
  }

  async drain(): Promise<void> {
    if (this.isDrained()) return;
    await new Promise<void>(resolve => this.drainWaiters.add(resolve));
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.drain();
      return;
    }
    this.state = "stopped";
    const error = cancellationError(reason || "Agent adapter catalog worker pool stopped.");
    for (const pending of [...this.queue]) this.cancelPending(pending, error);
    for (const slot of [...this.workers]) this.cancelActive(slot, error);
    await this.drain();
  }

  private enqueue(task: AgentAdapterCatalogWorkerTask, timeoutMs?: number): PendingScan {
    const canStartImmediately = this.active < this.maxConcurrency;
    if (!canStartImmediately && this.queue.length >= this.maxQueue) {
      const error = new AgentAdapterCatalogWorkerError(
        "Agent adapter catalog workers are busy; retry shortly.",
        "busy"
      );
      return {
        task,
        queuedAt: performance.now(),
        timeoutMs: this.timeoutMs,
        settled: true,
        promise: Promise.reject(error),
        resolve() {},
        reject() {}
      };
    }

    let resolvePending!: (value: unknown) => void;
    let rejectPending!: (error: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const pending: PendingScan = {
      task,
      queuedAt: performance.now(),
      timeoutMs: Math.max(100, Math.floor(timeoutMs ?? this.timeoutMs)),
      settled: false,
      promise,
      resolve: resolvePending,
      reject: rejectPending
    };
    this.queue.push(pending);
    this.startQueued();
    return pending;
  }

  private subscribe<T>(shared: SharedScan, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      if (shared.subscribers === 0 && !shared.completed) {
        this.cancelPending(shared.pending, cancellationError());
      }
      return Promise.reject(cancellationError());
    }

    shared.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (abortListener) signal?.removeEventListener("abort", abortListener);
        shared.subscribers -= 1;
        if (shared.subscribers === 0 && !shared.completed) {
          this.cancelPending(shared.pending, cancellationError());
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      const abortListener = signal
        ? () => finish(cancellationError())
        : undefined;
      if (abortListener) signal!.addEventListener("abort", abortListener, { once: true });
      void shared.pending.promise.then(
        value => finish(undefined, value),
        error => finish(error)
      );
    });
  }

  private completeShared(shared: SharedScan): void {
    shared.completed = true;
    if (this.inFlight.get(shared.key) === shared) this.inFlight.delete(shared.key);
    this.notifyDrainWaiters();
  }

  private startQueued(): void {
    if (this.state !== "accepting") return;
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      if (pending.settled) continue;
      const slot = this.createWorker(pending);
      if (!slot) {
        this.settlePending(
          pending,
          new AgentAdapterCatalogWorkerError("Agent adapter catalog worker could not start.", "worker_failed")
        );
        continue;
      }
      this.workers.add(slot);
      this.active += 1;
      this.spawnedWorkers += 1;
      recordPerformanceOperation(
        managerReadWorkerOperation("queue_wait", "agent_scan"),
        performance.now() - pending.queuedAt
      );
      this.send(slot);
    }
    this.notifyDrainWaiters();
  }

  private createWorker(pending: PendingScan): WorkerSlot | undefined {
    let worker: ChildProcess;
    try {
      worker = fork(workerEntryPath(), [], {
        execArgv: workerExecArgv(),
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          RABIROUTE_MANAGER_READ_PROCESS: "1",
          RABIROUTE_AGENT_ADAPTER_CATALOG_PROCESS: "1"
        }
      });
    } catch {
      return undefined;
    }
    if (!worker.pid) {
      if (worker.connected) worker.disconnect();
      worker.kill();
      return undefined;
    }
    try {
      os.setPriority(worker.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      if (worker.connected) worker.disconnect();
      worker.kill();
      return undefined;
    }

    const slot: WorkerSlot = {
      worker,
      active: {
        pending,
        requestId: String(this.nextRequestId++),
        startedAt: performance.now()
      },
      closed: false
    };
    slot.active.timer = setTimeout(() => {
      this.cancelActive(slot, new AgentAdapterCatalogWorkerError(
        `Agent adapter catalog scan exceeded ${pending.timeoutMs} ms.`,
        "timeout"
      ));
    }, pending.timeoutMs);
    slot.active.timer.unref?.();
    worker.on("message", message => this.handleMessage(slot, message as AgentAdapterCatalogWorkerResponse));
    worker.on("error", error => this.failSlot(
      slot,
      new AgentAdapterCatalogWorkerError(error.message, "worker_failed")
    ));
    worker.on("exit", code => this.handleExit(slot, code));
    unrefWorker(worker);
    return slot;
  }

  private send(slot: WorkerSlot): void {
    const request = {
      requestId: slot.active.requestId,
      task: slot.active.pending.task
    } satisfies AgentAdapterCatalogWorkerRequest;
    try {
      slot.worker.send(request, error => {
        if (error) {
          this.failSlot(slot, new AgentAdapterCatalogWorkerError(error.message, "worker_failed"));
        }
      });
    } catch (error) {
      this.failSlot(slot, new AgentAdapterCatalogWorkerError(
        error instanceof Error ? error.message : String(error),
        "worker_failed"
      ));
    }
  }

  private handleMessage(slot: WorkerSlot, message: AgentAdapterCatalogWorkerResponse): void {
    if (slot.closed || message.requestId !== slot.active.requestId) return;
    if (message.ok) this.finishSlot(slot, undefined, message.value);
    else this.finishSlot(slot, new AgentAdapterCatalogWorkerError(message.message, "worker_failed"));
  }

  private handleExit(slot: WorkerSlot, code: number | null): void {
    if (!slot.closed) {
      this.finishSlot(
        slot,
        new AgentAdapterCatalogWorkerError(
          `Agent adapter catalog worker exited with code ${code ?? "unknown"}.`,
          "worker_failed"
        ),
        undefined,
        false
      );
    }
    this.workers.delete(slot);
    this.notifyDrainWaiters();
  }

  private finishSlot(
    slot: WorkerSlot,
    error?: Error,
    value?: unknown,
    disconnect = true
  ): void {
    if (slot.closed) return;
    slot.closed = true;
    if (slot.active.timer) clearTimeout(slot.active.timer);
    this.active = Math.max(0, this.active - 1);
    recordPerformanceOperation(
      managerReadWorkerOperation("execute", "agent_scan"),
      performance.now() - slot.active.startedAt,
      Boolean(error)
    );
    this.settlePending(slot.active.pending, error, value);
    if (disconnect && slot.worker.connected) slot.worker.disconnect();
    this.startQueued();
    this.notifyDrainWaiters();
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    if (slot.closed) return;
    this.finishSlot(slot, error, undefined, false);
    this.trackTermination(slot.worker);
  }

  private cancelActive(slot: WorkerSlot, error: Error): void {
    if (slot.closed) return;
    this.finishSlot(slot, error, undefined, false);
    this.trackTermination(slot.worker);
  }

  private cancelPending(pending: PendingScan, error: Error): void {
    if (pending.settled) return;
    const queueIndex = this.queue.indexOf(pending);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      this.settlePending(pending, error);
      this.notifyDrainWaiters();
      return;
    }
    const slot = [...this.workers].find(candidate => candidate.active.pending === pending);
    if (slot) this.cancelActive(slot, error);
  }

  private settlePending(pending: PendingScan, error?: Error, value?: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private trackTermination(worker: ChildProcess): void {
    const termination = stopChildProcessTree(worker)
      .catch(() => {
        if (worker.exitCode === null) worker.kill();
      })
      .finally(() => {
        this.terminations.delete(termination);
        this.notifyDrainWaiters();
      });
    this.terminations.add(termination);
  }

  private isDrained(): boolean {
    return this.queue.length === 0
      && this.active === 0
      && this.inFlight.size === 0
      && this.workers.size === 0
      && this.terminations.size === 0;
  }

  private notifyDrainWaiters(): void {
    if (!this.isDrained()) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
