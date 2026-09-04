import { fork } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { managerReadWorkerOperation } from "../shared/performanceOperations.js";
import type {
  PersonaVoiceTranscriptQuery,
  PersonaVoiceTranscriptQueryResult
} from "../personaVoiceTranscriptView.js";
import type { PersonaSyncConflict } from "../personaSync.js";
import {
  publishRoleKnowledgeCatalogSnapshot,
  publishRolePlanCatalog,
  type PlanItem,
  type RoleKnowledgeCatalogSnapshot,
  type MemoryLifecyclePresentation,
  type RecentMemoryItem
} from "../roleKnowledge.js";
import type { PlanFeedbackRecoveryCandidate } from "./planFeedbackRecovery.js";
import type { RolePanelTimelineMessage } from "../rolePanelTimeline.js";
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
  terminationTimeoutMs?: number;
  forceTerminationTimeoutMs?: number;
  workerFactory?: () => ManagerReadWorkerChild;
  setWorkerPriority?: (pid: number) => void;
};

export type ManagerReadWorkerChild = {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected: boolean;
  readonly channel?: { unref?(): void } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
  unref(): void;
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
  terminationBlocked: boolean;
  blockedWorkerPids: number[];
  maxConcurrency: number;
  maxQueue: number;
  timeoutMs: number;
};

export type RolePlanCatalogRead = {
  plans: PlanItem[];
  approvalByPlanId: Record<string, { count: number; latest?: unknown }>;
};

export type RolePlanPageReadInput = {
  cursor: string;
  limit: number;
  view?: "current" | "plans" | "archived";
  query: string;
  sort: "status" | "updated" | "importance" | "urgency";
  statuses: string[];
  tags: string[];
  includeFacets: boolean;
  summary: boolean;
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
  settled: boolean;
};

type WorkerSlot = {
  worker: ManagerReadWorkerChild;
  active?: ActiveRead;
  closed: boolean;
  terminating: boolean;
  closedPromise: Promise<void>;
  resolveClosed(): void;
  terminationFlight?: Promise<boolean>;
  terminationCause?: Error;
};

export class ManagerReadWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "timeout" | "aborted" | "worker_failed" | "termination_unconfirmed"
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

function spawnManagerReadWorker(): ManagerReadWorkerChild {
  return fork(workerEntryPath(), [], {
    execArgv: workerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      RABIROUTE_MANAGER_READ_PROCESS: "1"
    }
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function closesWithin(slot: WorkerSlot, timeoutMs: number): Promise<boolean> {
  if (slot.closed) return Promise.resolve(true);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    slot.closedPromise.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function unrefWorker(worker: ManagerReadWorkerChild): void {
  worker.unref();
  worker.channel?.unref?.();
}

export class ManagerReadWorkerPool {
  private static readonly instances = new Set<ManagerReadWorkerPool>();
  // Read workers run below normal priority and never own message delivery. Keep
  // enough lanes for a visible knowledge page while a background catalog refresh
  // and an unrelated diagnostic are in flight.
  private static readonly globalMaxConcurrency = 6;
  private static globalActive = 0;
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly forceTerminationTimeoutMs: number;
  private readonly workerFactory: () => ManagerReadWorkerChild;
  private readonly setWorkerPriority: (pid: number) => void;
  private readonly queue: PendingRead[] = [];
  private readonly voiceSummaryInFlight = new Map<string, SharedRead<PersonaVoiceTranscriptQueryResult>>();
  private readonly performanceInFlight = new Map<string, SharedRead<string>>();
  private readonly rolePlanPageInFlight = new Map<string, SharedRead<unknown>>();
  private readonly roleMemoryPageInFlight = new Map<string, SharedRead<unknown>>();
  private readonly workers = new Set<WorkerSlot>();
  private readonly terminationPendingWorkers = new Set<WorkerSlot>();
  private readonly terminationBlockedWorkers = new Set<WorkerSlot>();
  private active = 0;
  private spawnedWorkers = 0;
  private nextRequestId = 1;
  private accepting = true;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(options: ManagerReadWorkerPoolOptions = {}) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 2));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 8));
    this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 30_000));
    this.terminationTimeoutMs = positiveInteger(options.terminationTimeoutMs, 1_000);
    this.forceTerminationTimeoutMs = positiveInteger(options.forceTerminationTimeoutMs, 5_000);
    this.workerFactory = options.workerFactory ?? spawnManagerReadWorker;
    this.setWorkerPriority = options.setWorkerPriority
      ?? ((pid) => os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL));
    ManagerReadWorkerPool.instances.add(this);
  }

  start(): void {
    if (!this.stopped) return;
    if (this.terminationBlockedWorkers.size > 0) {
      throw this.terminationBlockedError();
    }
    if (this.terminationPendingWorkers.size > 0) {
      throw new ManagerReadWorkerError("Manager read worker termination is still in progress.", "busy");
    }
    if (this.active || this.queue.length || this.workers.size) {
      throw new Error("Manager read worker pool cannot restart while resources are still active.");
    }
    this.accepting = true;
    this.stopped = false;
    this.stopPromise = undefined;
    ManagerReadWorkerPool.instances.add(this);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped && this.workers.size === 0 && this.active === 0) return Promise.resolve();
    const flight = this.stopOnce();
    this.stopPromise = flight.catch(error => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.accepting = false;
    ManagerReadWorkerPool.instances.delete(this);
    const stoppingError = new ManagerReadWorkerError("Manager read worker pool stopped.", "aborted");
    this.rejectQueue(stoppingError);
    for (const shared of this.voiceSummaryInFlight.values()) shared.controller.abort();
    for (const shared of this.performanceInFlight.values()) shared.controller.abort();
    for (const shared of this.rolePlanPageInFlight.values()) shared.controller.abort();
    for (const shared of this.roleMemoryPageInFlight.values()) shared.controller.abort();
    const slots = [...this.workers];
    const closed = await Promise.all(slots.map(slot => this.discardWorker(slot, stoppingError)));
    const unconfirmed = slots.filter((_slot, index) => !closed[index]);
    if (unconfirmed.length > 0 || this.workers.size > 0 || this.active > 0) {
      const pids = [...new Set([
        ...unconfirmed,
        ...this.workers
      ].map(slot => slot.worker.pid).filter((pid): pid is number => typeof pid === "number"))];
      throw new ManagerReadWorkerError(
        `Manager read worker pool cannot stop while worker termination is unconfirmed: pids=${pids.join(",") || "unknown"}.`,
        "termination_unconfirmed"
      );
    }
    this.voiceSummaryInFlight.clear();
    this.performanceInFlight.clear();
    this.rolePlanPageInFlight.clear();
    this.roleMemoryPageInFlight.clear();
    this.stopped = true;
  }

  run<T>(task: ManagerReadWorkerTask, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new ManagerReadWorkerError("Manager read worker pool is stopped.", "aborted"));
    }
    if (this.terminationBlockedWorkers.size > 0) {
      return Promise.reject(this.terminationBlockedError());
    }
    if (this.terminationPendingWorkers.size > 0) {
      return Promise.reject(new ManagerReadWorkerError(
        "Manager read worker termination is still in progress; retry shortly.",
        "busy"
      ));
    }
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

  queryRoleKnowledgeCatalogSnapshot(
    roleDir: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<RoleKnowledgeCatalogSnapshot> {
    return this.run<RoleKnowledgeCatalogSnapshot>({
      type: "role_knowledge_catalog_snapshot",
      roleDir
    }, options).then(snapshot => publishRoleKnowledgeCatalogSnapshot(roleDir, snapshot));
  }

  queryRolePlanCatalog(
    roleDir: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<RolePlanCatalogRead> {
    return this.run<RolePlanCatalogRead>({ type: "role_plan_catalog", roleDir }, options)
      .then(result => ({
        ...result,
        plans: [...publishRolePlanCatalog(roleDir, result.plans)]
      }));
  }

  queryRolePlanPage<T>(
    roleDir: string,
    input: RolePlanPageReadInput,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    const key = JSON.stringify(["role_plan_page", roleDir, input]);
    return this.querySharedRead<T>(
      this.rolePlanPageInFlight,
      key,
      { type: "role_plan_page", roleDir, ...input },
      options
    );
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

  queryPlanFeedbackRecoveryCandidates(
    rolesRoot: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<PlanFeedbackRecoveryCandidate[]> {
    return this.run<PlanFeedbackRecoveryCandidate[]>({
      type: "plan_feedback_recovery_candidates",
      rolesRoot
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
    const key = JSON.stringify(["role_memory_page", roleDir, input]);
    return this.querySharedRead<T>(
      this.roleMemoryPageInFlight,
      key,
      { type: "role_memory_page", roleDir, ...input },
      options
    );
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

  queryRolePanelTimeline(
    rolesRoot: string,
    roleId: string,
    limit: number,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<RolePanelTimelineMessage[]> {
    return this.run<RolePanelTimelineMessage[]>({
      type: "role_panel_timeline_read",
      rolesRoot,
      roleId,
      limit
    }, options);
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
      terminationBlocked: this.terminationBlockedWorkers.size > 0,
      blockedWorkerPids: [...this.terminationBlockedWorkers]
        .map(slot => slot.worker.pid)
        .filter((pid): pid is number => typeof pid === "number"),
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
    return this.querySharedRead<string>(this.performanceInFlight, key, task, options);
  }

  private querySharedRead<T>(
    inFlight: Map<string, SharedRead<unknown>> | Map<string, SharedRead<T>>,
    key: string,
    task: ManagerReadWorkerTask,
    options: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    let shared = inFlight.get(key) as SharedRead<T> | undefined;
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        promise: Promise.resolve(undefined as never),
        subscribers: 0,
        completed: false
      };
      const current = shared;
      current.promise = this.run<T>(task, {
        signal: controller.signal,
        timeoutMs: options.timeoutMs
      }).finally(() => {
        current.completed = true;
        if (inFlight.get(key) === current) inFlight.delete(key);
      });
      inFlight.set(key, current);
    }
    return this.subscribe(shared, options.signal);
  }

  private drain(): void {
    while (
      this.accepting
      && this.terminationPendingWorkers.size === 0
      && this.terminationBlockedWorkers.size === 0
      && this.active < this.maxConcurrency
      && ManagerReadWorkerPool.globalActive < ManagerReadWorkerPool.globalMaxConcurrency
      && this.queue.length > 0
    ) {
      const pending = this.queue.shift()!;
      if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
      if (pending.signal?.aborted) {
        pending.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        continue;
      }
      const slot = [...this.workers].find(candidate => !candidate.closed && !candidate.terminating && !candidate.active)
        ?? this.createWorker();
      if (!slot) {
        pending.reject(new ManagerReadWorkerError("Manager read worker could not start.", "worker_failed"));
        continue;
      }
      this.startPending(slot, pending);
    }
  }

  private createWorker(): WorkerSlot | undefined {
    let worker: ManagerReadWorkerChild;
    try {
      worker = this.workerFactory();
    } catch {
      return undefined;
    }
    let resolveClosed = (): void => {};
    const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
    const slot: WorkerSlot = {
      worker,
      closed: false,
      terminating: false,
      closedPromise,
      resolveClosed
    };
    this.workers.add(slot);
    this.spawnedWorkers += 1;
    worker.on("message", message => this.handleWorkerMessage(slot, message as ManagerReadWorkerMessage));
    worker.once("error", error => {
      void this.discardWorker(slot, new ManagerReadWorkerError(
        error instanceof Error ? error.message : String(error),
        "worker_failed"
      ));
    });
    worker.once("exit", (code, signal) => {
      if (slot.closed || slot.terminating) return;
      void this.discardWorker(
        slot,
        slot.active
          ? new ManagerReadWorkerError(
              `Manager read worker exited with code ${code ?? "none"}; signal=${signal ?? "none"}.`,
              "worker_failed"
            )
          : undefined
      );
    });
    worker.once("close", (code, signal) => this.handleWorkerClose(slot, code, signal));
    if (!worker.pid) {
      void this.discardWorker(
        slot,
        new ManagerReadWorkerError("Manager read worker did not publish a process id.", "worker_failed")
      );
      return undefined;
    }
    try {
      this.setWorkerPriority(worker.pid);
    } catch (error) {
      void this.discardWorker(
        slot,
        new ManagerReadWorkerError(
          `Manager read worker priority setup failed: ${error instanceof Error ? error.message : String(error)}`,
          "worker_failed"
        )
      );
      return undefined;
    }
    unrefWorker(worker);
    return slot;
  }

  private startPending(slot: WorkerSlot, pending: PendingRead): void {
    this.active += 1;
    ManagerReadWorkerPool.globalActive += 1;
    recordPerformanceOperation(
      managerReadWorkerOperation("queue_wait", pending.task.type),
      performance.now() - pending.queuedAt
    );
    const startedAt = performance.now();
    const requestId = String(this.nextRequestId++);
    const timer = setTimeout(() => {
      void this.discardWorker(
        slot,
        new ManagerReadWorkerError(`Manager read exceeded ${pending.timeoutMs} ms.`, "timeout")
      );
    }, pending.timeoutMs);
    timer.unref?.();
    const abortListener = pending.signal
      ? () => {
          void this.discardWorker(slot, new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        }
      : undefined;
    if (abortListener) pending.signal!.addEventListener("abort", abortListener, { once: true });
    slot.active = { pending, requestId, startedAt, timer, abortListener, settled: false };
    try {
      slot.worker.send(
        { requestId, task: pending.task } satisfies ManagerReadWorkerRequest,
        error => {
          if (!error || slot.active?.requestId !== requestId) return;
          void this.discardWorker(slot, new ManagerReadWorkerError(error.message, "worker_failed"));
        }
      );
    } catch (error) {
      void this.discardWorker(
        slot,
        new ManagerReadWorkerError(error instanceof Error ? error.message : String(error), "worker_failed")
      );
    }
  }

  private handleWorkerMessage(slot: WorkerSlot, message: ManagerReadWorkerMessage): void {
    const current = slot.active;
    if (slot.terminating || !current || current.settled || current.requestId !== message.requestId) return;
    if (message.ok) this.finish(slot, undefined, message.value);
    else this.finish(slot, new ManagerReadWorkerError(message.message, "worker_failed"));
  }

  private finish(slot: WorkerSlot, error?: Error, value?: unknown): void {
    const current = slot.active;
    if (!current || slot.terminating || current.settled) return;
    this.settleActivePromise(current, error, value);
    this.releaseActiveLease(slot, current);
    unrefWorker(slot.worker);
    ManagerReadWorkerPool.drainAll();
  }

  private async discardWorker(slot: WorkerSlot, error?: Error): Promise<boolean> {
    if (slot.closed) return true;
    if (error && !slot.terminationCause) slot.terminationCause = error;
    slot.terminating = true;
    this.terminationPendingWorkers.add(slot);
    const current = slot.active;
    if (current) {
      this.clearActiveDeadline(current);
    }
    const confirmed = await this.terminateAndConfirm(slot);
    if (confirmed) return true;
    const blockedError = new ManagerReadWorkerError(
      `${slot.terminationCause?.message ?? "Manager read worker stopped."} `
        + `Worker termination was not confirmed: pid=${slot.worker.pid ?? "unknown"}.`,
      "termination_unconfirmed"
    );
    this.blockTermination(slot, blockedError);
    if (current && !current.settled) this.settleActivePromise(current, blockedError);
    this.rejectQueue(blockedError);
    return false;
  }

  private terminateAndConfirm(slot: WorkerSlot): Promise<boolean> {
    if (slot.closed) return Promise.resolve(true);
    if (slot.terminationFlight) return slot.terminationFlight;
    slot.terminationFlight = (async () => {
      try { slot.worker.kill("SIGTERM"); } catch { /* close observation is authoritative */ }
      if (await closesWithin(slot, this.terminationTimeoutMs)) return true;
      try { slot.worker.kill("SIGKILL"); } catch { /* reported below if close remains absent */ }
      const confirmed = await closesWithin(slot, this.forceTerminationTimeoutMs);
      if (confirmed) return true;
      unrefWorker(slot.worker);
      return false;
    })();
    return slot.terminationFlight;
  }

  private handleWorkerClose(slot: WorkerSlot, code: number | null, signal: NodeJS.Signals | null): void {
    if (slot.closed) return;
    slot.closed = true;
    slot.terminating = false;
    slot.resolveClosed();
    this.workers.delete(slot);
    this.terminationPendingWorkers.delete(slot);
    this.terminationBlockedWorkers.delete(slot);
    const current = slot.active;
    if (current) {
      this.clearActiveDeadline(current);
      if (!current.settled) {
        this.settleActivePromise(
          current,
          slot.terminationCause ?? new ManagerReadWorkerError(
            `Manager read worker closed before responding: code=${code ?? "none"}; signal=${signal ?? "none"}.`,
            "worker_failed"
          )
        );
      }
      this.releaseActiveLease(slot, current);
    }
    ManagerReadWorkerPool.drainAll();
  }

  private clearActiveDeadline(current: ActiveRead): void {
    clearTimeout(current.timer);
    if (current.abortListener) current.pending.signal?.removeEventListener("abort", current.abortListener);
  }

  private settleActivePromise(current: ActiveRead, error?: Error, value?: unknown): void {
    if (current.settled) return;
    current.settled = true;
    this.clearActiveDeadline(current);
    recordPerformanceOperation(
      managerReadWorkerOperation("execute", current.pending.task.type),
      performance.now() - current.startedAt,
      Boolean(error)
    );
    if (error) current.pending.reject(error);
    else current.pending.resolve(value);
  }

  private releaseActiveLease(slot: WorkerSlot, current: ActiveRead): void {
    if (slot.active !== current) return;
    slot.active = undefined;
    this.active -= 1;
    ManagerReadWorkerPool.globalActive -= 1;
  }

  private rejectQueue(error: Error): void {
    for (const pending of this.queue.splice(0)) {
      if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
      pending.reject(error);
    }
  }

  private terminationBlockedError(): ManagerReadWorkerError {
    const pids = [...this.terminationBlockedWorkers]
      .map(slot => slot.worker.pid)
      .filter((pid): pid is number => typeof pid === "number");
    return new ManagerReadWorkerError(
      `Manager read worker termination is not confirmed: pids=${pids.join(",") || "unknown"}.`,
      "termination_unconfirmed"
    );
  }

  private blockTermination(slot: WorkerSlot, error: ManagerReadWorkerError): void {
    this.terminationBlockedWorkers.add(slot);
    this.rejectQueue(error);
  }

  private static drainAll(): void {
    for (const pool of ManagerReadWorkerPool.instances) pool.drain();
  }
}

export const managerReadWorkerPool = new ManagerReadWorkerPool();
/**
 * User-driven knowledge pages must not wait behind startup reconciliation or
 * background catalog refreshes. Requests still share the global bounded budget.
 */
export const managerKnowledgePageWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 4,
  maxQueue: 32,
  timeoutMs: 30_000
});
export const managerCatalogWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 16,
  timeoutMs: 5 * 60_000,
  setWorkerPriority: (pid) => os.setPriority(pid, os.constants.priority.PRIORITY_LOW)
});
export const managerPerformanceWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 1,
  timeoutMs: 60_000
});

const builtinManagerReadWorkerPools = [
  managerReadWorkerPool,
  managerKnowledgePageWorkerPool,
  managerCatalogWorkerPool,
  managerPerformanceWorkerPool
] as const;

export function startBuiltinManagerReadWorkerPools(): void {
  for (const pool of builtinManagerReadWorkerPools) pool.start();
}

export async function stopBuiltinManagerReadWorkerPools(): Promise<void> {
  await Promise.all(builtinManagerReadWorkerPools.map(pool => pool.stop()));
}
