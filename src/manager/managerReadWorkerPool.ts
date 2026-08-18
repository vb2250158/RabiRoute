import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { managerReadWorkerOperation } from "../shared/performanceOperations.js";
import type {
  PersonaVoiceTranscriptQuery,
  PersonaVoiceTranscriptQueryResult
} from "../personaVoiceTranscriptView.js";
import type { PersonaSyncConflict } from "../personaSync.js";
import type {
  MemoryLifecyclePresentation,
  RecentMemoryItem
} from "../roleKnowledge.js";
import type {
  AgentScanOptions,
  AgentScanRuntimeSnapshot
} from "../agentAdapters/managerApi.js";
import type {
  PerformanceMonitoringConfig,
  PerformanceStoreStatus
} from "../shared/performanceContract.js";
import type {
  ManagerReadWorkerMessage,
  ManagerReadWorkerRequest,
  ManagerReadWorkerTask
} from "./managerReadWorker.js";

export type ManagerReadWorkerPoolOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};

export type ManagerReadWorkerPoolStatus = {
  executionMode: "child_process";
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

type PendingRead = {
  task: ManagerReadWorkerTask;
  queuedAt: number;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve(value: unknown): void;
  reject(error: Error): void;
  abortListener?: () => void;
};

type SharedRead<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  completed: boolean;
};

type ActiveRead = {
  pending: PendingRead;
  requestId: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  abortListener?: () => void;
};

type WorkerSlot = {
  worker: ChildProcess;
  active?: ActiveRead;
  closed: boolean;
};

export class ManagerReadWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "timeout" | "aborted" | "worker_failed"
  ) {
    super(message);
    this.name = "ManagerReadWorkerError";
  }
}

function workerEntryPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./managerReadWorker.ts" : "./managerReadWorker.js",
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

export class ManagerReadWorkerPool {
  private static readonly instances = new Set<ManagerReadWorkerPool>();
  private static readonly globalMaxConcurrency = 2;
  private static globalActive = 0;
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly queue: PendingRead[] = [];
  private readonly voiceSummaryInFlight = new Map<string, SharedRead<PersonaVoiceTranscriptQueryResult>>();
  private readonly agentScanInFlight = new Map<string, SharedRead<Record<string, unknown>>>();
  private readonly performanceInFlight = new Map<string, SharedRead<string>>();
  private readonly workers = new Set<WorkerSlot>();
  private active = 0;
  private spawnedWorkers = 0;
  private nextRequestId = 1;

  constructor(options: ManagerReadWorkerPoolOptions = {}) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 2));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 8));
    this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 30_000));
    ManagerReadWorkerPool.instances.add(this);
  }

  run<T>(task: ManagerReadWorkerTask, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
    }
    const canStartImmediately = this.active < this.maxConcurrency
      && ManagerReadWorkerPool.globalActive < ManagerReadWorkerPool.globalMaxConcurrency;
    if (!canStartImmediately && this.queue.length >= this.maxQueue) {
      return Promise.reject(new ManagerReadWorkerError("Manager read workers are busy; retry shortly.", "busy"));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRead = {
        task,
        queuedAt: performance.now(),
        timeoutMs: Math.max(100, Math.floor(options.timeoutMs ?? this.timeoutMs)),
        signal: options.signal,
        resolve: value => resolve(value as T),
        reject
      };
      if (pending.signal) {
        pending.abortListener = () => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          pending.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        };
        pending.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.queue.push(pending);
      this.drain();
    });
  }

  queryPersonaVoiceTranscripts(
    roleDir: string,
    query: PersonaVoiceTranscriptQuery,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<PersonaVoiceTranscriptQueryResult> {
    const task: ManagerReadWorkerTask = {
      type: "persona_voice_transcripts",
      roleDir,
      query
    };
    if (query.includeDetails !== false) return this.run<PersonaVoiceTranscriptQueryResult>(task, options);
    const key = JSON.stringify([
      roleDir,
      query.includeArchives === true,
      query.speaker || "",
      query.from ?? "",
      query.to ?? ""
    ]);
    let shared = this.voiceSummaryInFlight.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        promise: Promise.resolve(undefined as never),
        subscribers: 0,
        completed: false
      };
      const current = shared;
      current.promise = this.run<PersonaVoiceTranscriptQueryResult>(task, {
        signal: controller.signal,
        timeoutMs: options.timeoutMs
      }).finally(() => {
        current.completed = true;
        if (this.voiceSummaryInFlight.get(key) === current) this.voiceSummaryInFlight.delete(key);
      });
      this.voiceSummaryInFlight.set(key, current);
    }
    return this.subscribe(shared, options.signal);
  }

  queryPersonaSyncConflicts(
    rolesRoot: string,
    stateRoot: string,
    roleId?: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<PersonaSyncConflict[]> {
    return this.run<PersonaSyncConflict[]>({
      type: "persona_sync_conflicts",
      rolesRoot,
      stateRoot,
      roleId
    }, options);
  }

  queryRecentMemoryDetail(
    roleDir: string,
    memoryId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<(RecentMemoryItem & { lifecycle: MemoryLifecyclePresentation }) | null> {
    return this.run<(RecentMemoryItem & { lifecycle: MemoryLifecyclePresentation }) | null>({
      type: "role_memory_catalog",
      roleDir,
      kind: "recent",
      memoryId
    }, options);
  }

  queryRoleMemoryCatalog<T>(
    roleDir: string,
    kind: "recent" | "consolidated" | "archived",
    memoryId?: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    return this.run<T>({
      type: "role_memory_catalog",
      roleDir,
      kind,
      memoryId
    }, options);
  }

  queryRoleMemoryPage<T>(
    roleDir: string,
    input: {
      kind: "recent" | "consolidated" | "archived";
      cursor: string;
      limit: number;
      query: string;
    },
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    return this.run<T>({ type: "role_memory_page", roleDir, ...input }, options);
  }

  queryRoleMemoryOverview<T>(
    roleDir: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    return this.run<T>({ type: "role_memory_overview", roleDir }, options);
  }

  queryRoleMemoryCounts<T>(
    roleDir: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    return this.run<T>({ type: "role_memory_counts", roleDir }, options);
  }

  queryAgentScan<T>(
    rootDir: string,
    runtimes: AgentScanRuntimeSnapshot[],
    scanOptions: AgentScanOptions,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    const key = JSON.stringify([rootDir, runtimes, scanOptions]);
    let shared = this.agentScanInFlight.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        promise: Promise.resolve(undefined as never),
        subscribers: 0,
        completed: false
      };
      const current = shared;
      current.promise = this.run<Record<string, unknown>>({
        type: "agent_scan",
        rootDir,
        runtimes,
        options: scanOptions
      }, {
        signal: controller.signal,
        timeoutMs: options.timeoutMs
      }).finally(() => {
        current.completed = true;
        if (this.agentScanInFlight.get(key) === current) this.agentScanInFlight.delete(key);
      });
      this.agentScanInFlight.set(key, current);
    }
    return this.subscribe(shared, options.signal) as Promise<T>;
  }

  queryPerformanceSummaryJson(
    logDirectory: string,
    rangeMs: number,
    config: PerformanceMonitoringConfig,
    status: PerformanceStoreStatus,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<string> {
    return this.querySharedPerformance(
      JSON.stringify(["summary", logDirectory, rangeMs, status.lastPersistedAt, status.retainedRecords]),
      { type: "performance_summary", logDirectory, rangeMs, config, status },
      options
    );
  }

  queryPerformanceLogsJson(
    logDirectory: string,
    limit: number,
    status: PerformanceStoreStatus,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<string> {
    return this.querySharedPerformance(
      JSON.stringify(["logs", logDirectory, limit, status.lastPersistedAt, status.retainedRecords]),
      { type: "performance_logs", logDirectory, limit, status },
      options
    );
  }

  status(): ManagerReadWorkerPoolStatus {
    return {
      executionMode: "child_process",
      active: this.active,
      queued: this.queue.length,
      workers: this.workers.size,
      workerPids: [...this.workers]
        .map(slot => slot.worker.pid)
        .filter((pid): pid is number => typeof pid === "number"),
      spawnedWorkers: this.spawnedWorkers,
      globalActive: ManagerReadWorkerPool.globalActive,
      globalMaxConcurrency: ManagerReadWorkerPool.globalMaxConcurrency,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
      timeoutMs: this.timeoutMs
    };
  }

  private subscribe<T>(shared: SharedRead<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      if (shared.subscribers === 0 && !shared.completed) shared.controller.abort();
      return Promise.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
    }
    shared.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T): void => {
        if (settled) return;
        settled = true;
        if (abortListener) signal?.removeEventListener("abort", abortListener);
        shared.subscribers -= 1;
        if (shared.subscribers === 0 && !shared.completed) shared.controller.abort();
        if (error) reject(error);
        else resolve(value as T);
      };
      const abortListener = signal
        ? () => finish(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"))
        : undefined;
      if (abortListener) signal!.addEventListener("abort", abortListener, { once: true });
      void shared.promise.then(value => finish(undefined, value), error => finish(error));
    });
  }

  private querySharedPerformance(
    key: string,
    task: ManagerReadWorkerTask,
    options: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<string> {
    let shared = this.performanceInFlight.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        promise: Promise.resolve(""),
        subscribers: 0,
        completed: false
      };
      const current = shared;
      current.promise = this.run<string>(task, {
        signal: controller.signal,
        timeoutMs: options.timeoutMs
      }).finally(() => {
        current.completed = true;
        if (this.performanceInFlight.get(key) === current) this.performanceInFlight.delete(key);
      });
      this.performanceInFlight.set(key, current);
    }
    return this.subscribe(shared, options.signal);
  }

  private drain(): void {
    while (
      this.active < this.maxConcurrency
      && ManagerReadWorkerPool.globalActive < ManagerReadWorkerPool.globalMaxConcurrency
      && this.queue.length > 0
    ) {
      const pending = this.queue.shift()!;
      if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
      if (pending.signal?.aborted) {
        pending.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        continue;
      }
      const slot = [...this.workers].find(candidate => !candidate.closed && !candidate.active)
        ?? this.createWorker();
      if (!slot) {
        pending.reject(new ManagerReadWorkerError("Manager read worker could not start.", "worker_failed"));
        continue;
      }
      this.start(slot, pending);
    }
  }

  private createWorker(): WorkerSlot | undefined {
    let worker: ChildProcess;
    try {
      worker = fork(workerEntryPath(), [], {
        execArgv: workerExecArgv(),
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          RABIROUTE_MANAGER_READ_PROCESS: "1"
        }
      });
    } catch {
      return undefined;
    }
    const slot: WorkerSlot = { worker, closed: false };
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
    this.workers.add(slot);
    this.spawnedWorkers += 1;
    worker.on("message", message => this.handleWorkerMessage(slot, message as ManagerReadWorkerMessage));
    worker.on("error", error => this.discardWorker(
      slot,
      new ManagerReadWorkerError(error.message, "worker_failed")
    ));
    worker.on("exit", code => {
      if (slot.closed) return;
      this.discardWorker(
        slot,
        slot.active
          ? new ManagerReadWorkerError(`Manager read worker exited with code ${code}.`, "worker_failed")
          : undefined
      );
    });
    unrefWorker(worker);
    return slot;
  }

  private start(slot: WorkerSlot, pending: PendingRead): void {
    this.active += 1;
    ManagerReadWorkerPool.globalActive += 1;
    recordPerformanceOperation(
      managerReadWorkerOperation("queue_wait", pending.task.type),
      performance.now() - pending.queuedAt
    );
    const startedAt = performance.now();
    const requestId = String(this.nextRequestId++);
    const timer = setTimeout(() => {
      this.discardWorker(
        slot,
        new ManagerReadWorkerError(`Manager read exceeded ${pending.timeoutMs} ms.`, "timeout")
      );
    }, pending.timeoutMs);
    timer.unref?.();
    const abortListener = pending.signal
      ? () => {
          this.discardWorker(slot, new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        }
      : undefined;
    if (abortListener) pending.signal!.addEventListener("abort", abortListener, { once: true });
    slot.active = { pending, requestId, startedAt, timer, abortListener };
    try {
      slot.worker.send(
        { requestId, task: pending.task } satisfies ManagerReadWorkerRequest,
        error => {
          if (!error || slot.active?.requestId !== requestId) return;
          this.discardWorker(slot, new ManagerReadWorkerError(error.message, "worker_failed"));
        }
      );
    } catch (error) {
      this.discardWorker(
        slot,
        new ManagerReadWorkerError(error instanceof Error ? error.message : String(error), "worker_failed")
      );
    }
  }

  private handleWorkerMessage(slot: WorkerSlot, message: ManagerReadWorkerMessage): void {
    const current = slot.active;
    if (!current || current.requestId !== message.requestId) return;
    if (message.ok) this.finish(slot, undefined, message.value);
    else this.finish(slot, new ManagerReadWorkerError(message.message, "worker_failed"));
  }

  private finish(slot: WorkerSlot, error?: Error, value?: unknown): void {
    const current = slot.active;
    if (!current) return;
    slot.active = undefined;
    clearTimeout(current.timer);
    if (current.abortListener) current.pending.signal?.removeEventListener("abort", current.abortListener);
    this.active -= 1;
    ManagerReadWorkerPool.globalActive -= 1;
    recordPerformanceOperation(
      managerReadWorkerOperation("execute", current.pending.task.type),
      performance.now() - current.startedAt,
      Boolean(error)
    );
    if (error) current.pending.reject(error);
    else current.pending.resolve(value);
    unrefWorker(slot.worker);
    ManagerReadWorkerPool.drainAll();
  }

  private discardWorker(slot: WorkerSlot, error?: Error): void {
    if (slot.closed) return;
    slot.closed = true;
    this.workers.delete(slot);
    const current = slot.active;
    if (current) {
      slot.active = undefined;
      clearTimeout(current.timer);
      if (current.abortListener) current.pending.signal?.removeEventListener("abort", current.abortListener);
      this.active -= 1;
      ManagerReadWorkerPool.globalActive -= 1;
      recordPerformanceOperation(
        managerReadWorkerOperation("execute", current.pending.task.type),
        performance.now() - current.startedAt,
        true
      );
      current.pending.reject(error ?? new ManagerReadWorkerError("Manager read worker stopped.", "worker_failed"));
    }
    if (slot.worker.connected) slot.worker.disconnect();
    slot.worker.kill();
    ManagerReadWorkerPool.drainAll();
  }

  private static drainAll(): void {
    for (const pool of ManagerReadWorkerPool.instances) pool.drain();
  }
}

export const managerReadWorkerPool = new ManagerReadWorkerPool();
export const managerCatalogWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 1,
  timeoutMs: 5 * 60_000
});
export const managerAgentScanWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 1,
  timeoutMs: 5 * 60_000
});
export const managerPerformanceWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 1,
  timeoutMs: 60_000
});
