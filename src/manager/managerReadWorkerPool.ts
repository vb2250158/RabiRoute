import { Worker } from "node:worker_threads";
import type {
  PersonaVoiceTranscriptQuery,
  PersonaVoiceTranscriptQueryResult
} from "../personaVoiceTranscriptView.js";
import type { PersonaSyncConflict } from "../personaSync.js";
import type { ManagerReadWorkerResponse, ManagerReadWorkerTask } from "./managerReadWorker.js";

export type ManagerReadWorkerPoolOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};

export type ManagerReadWorkerPoolStatus = {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
  timeoutMs: number;
};

type PendingRead = {
  task: ManagerReadWorkerTask;
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

export class ManagerReadWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "timeout" | "aborted" | "worker_failed"
  ) {
    super(message);
    this.name = "ManagerReadWorkerError";
  }
}

function workerEntryUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./managerReadWorker.ts" : "./managerReadWorker.js", import.meta.url);
}

export class ManagerReadWorkerPool {
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly queue: PendingRead[] = [];
  private readonly voiceSummaryInFlight = new Map<string, SharedRead<PersonaVoiceTranscriptQueryResult>>();
  private active = 0;

  constructor(options: ManagerReadWorkerPoolOptions = {}) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 2));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 8));
    this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 30_000));
  }

  run<T>(task: ManagerReadWorkerTask, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
    }
    if (this.active >= this.maxConcurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(new ManagerReadWorkerError("Manager read workers are busy; retry shortly.", "busy"));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRead = {
        task,
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

  status(): ManagerReadWorkerPoolStatus {
    return {
      active: this.active,
      queued: this.queue.length,
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

  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
      if (pending.signal?.aborted) {
        pending.reject(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        continue;
      }
      this.start(pending);
    }
  }

  private start(pending: PendingRead): void {
    this.active += 1;
    let worker: Worker;
    try {
      worker = new Worker(workerEntryUrl(), { workerData: pending.task });
    } catch (error) {
      this.active -= 1;
      pending.reject(new ManagerReadWorkerError(error instanceof Error ? error.message : String(error), "worker_failed"));
      this.drain();
      return;
    }
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener) pending.signal?.removeEventListener("abort", abortListener);
      this.active -= 1;
      if (error) pending.reject(error);
      else pending.resolve(value);
      this.drain();
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new ManagerReadWorkerError(`Manager read exceeded ${pending.timeoutMs} ms.`, "timeout"));
    }, pending.timeoutMs);
    timer.unref?.();
    const abortListener = pending.signal
      ? () => {
          void worker.terminate();
          finish(new ManagerReadWorkerError("Manager read request was aborted.", "aborted"));
        }
      : undefined;
    if (abortListener) pending.signal!.addEventListener("abort", abortListener, { once: true });
    worker.once("message", (message: ManagerReadWorkerResponse) => {
      void worker.terminate();
      if (message.ok) finish(undefined, message.value);
      else finish(new ManagerReadWorkerError(message.message, "worker_failed"));
    });
    worker.once("error", error => finish(new ManagerReadWorkerError(error.message, "worker_failed")));
    worker.once("exit", code => {
      if (!settled && code !== 0) finish(new ManagerReadWorkerError(`Manager read worker exited with code ${code}.`, "worker_failed"));
    });
  }
}

export const managerReadWorkerPool = new ManagerReadWorkerPool();
export const managerCatalogWorkerPool = new ManagerReadWorkerPool({
  maxConcurrency: 1,
  maxQueue: 1,
  timeoutMs: 5 * 60_000
});
