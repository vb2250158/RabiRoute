import { getTimeoutMs } from "./runtimeTimeouts.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LoadedPluginPackage } from "./packageLoader.js";
import type { PluginProfile } from "./profile.js";
import type { PluginHost } from "./types.js";

export type PackageCatalogRoot = Readonly<{ path: string; inProcessTrusted: boolean }>;
export type PluginPackageLoadTask =
  | Readonly<{ kind: "package"; packageId: string; version: string; runtimeRoot: string; host: PluginHost; roots: readonly PackageCatalogRoot[] }>
  | Readonly<{ kind: "profile"; profilePath: string }>
  | Readonly<{ kind: "cleanup"; runtimeRoot: string; stagingId: string }>;
export type PluginPackageLoadRequest = Readonly<{ id: string; task: PluginPackageLoadTask }>;
export type PluginPackageLoadReply = Readonly<{ id: string; ok: true; value: LoadedPluginPackage | PluginProfile | undefined }>
  | Readonly<{ id: string; ok: false; error: string }>;
export type PluginPackageLoadingOptions = Readonly<{
  maxConcurrency?: number; maxQueue?: number; timeoutMs?: number; cleanupTimeoutMs?: number;
  /** Trusted test host override, never supplied by a Profile or API request. */
  workerURL?: URL;
}>;
type Job = {
  id: string; task: PluginPackageLoadTask; deadlineAt: number; cancelled?: Error; stop?: () => void;
  queueTimer?: NodeJS.Timeout;
  resolve(value: LoadedPluginPackage | PluginProfile | undefined): void; reject(error: Error): void;
  promise: Promise<LoadedPluginPackage | PluginProfile | undefined>; closed: Promise<void>;
};

const osEnvironmentKeys = new Set(["systemroot", "windir", "path", "pathext", "temp", "tmp", "tmpdir", "lang", "lc_all", "lc_ctype", "rabiroute_timeout_overrides"]);
function workerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && osEnvironmentKeys.has(key.toLowerCase())));
}
function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error("Invalid plugin package loading limit.");
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Owns metadata-only children. No slot or result is released before child close. */
export class PluginPackageLoader {
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #timeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #queue: Job[] = [];
  readonly #active = new Set<Job>();
  readonly #inflight = new Map<string, Job>();
  readonly #children = new Set<ChildProcess>();
  #disposed = false;
  #disposal?: Promise<void>;

  constructor(private readonly options: PluginPackageLoadingOptions = {}) {
    this.#maxConcurrency = limit(options.maxConcurrency, 2, 1, 16);
    this.#maxQueue = limit(options.maxQueue, 32, 0, 1024);
    this.#timeoutMs = limit(options.timeoutMs, getTimeoutMs("plugin.packageLoad", 30000), 1, 2147483647);
    this.#cleanupTimeoutMs = limit(options.cleanupTimeoutMs, getTimeoutMs("plugin.packageCleanup", 5000), 1, 2147483647);
  }

  load(task: Exclude<PluginPackageLoadTask, { kind: "cleanup" }>): Promise<LoadedPluginPackage | PluginProfile> {
    if (this.#disposed) return Promise.reject(new Error("Plugin package catalog is disposed."));
    const key = JSON.stringify(task), existing = this.#inflight.get(key);
    if (existing) return existing.promise as Promise<LoadedPluginPackage | PluginProfile>;
    if (this.#active.size >= this.#maxConcurrency && this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new Error("Plugin package loading queue is full."));
    }
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<LoadedPluginPackage | PluginProfile | undefined>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { id: randomUUID(), task, deadlineAt: Date.now() + this.#timeoutMs, resolve, reject, promise, closed: Promise.resolve() };
    this.#inflight.set(key, job);
    void promise.then(() => this.#inflight.delete(key), () => this.#inflight.delete(key));
    job.queueTimer = setTimeout(() => {
      const index = this.#queue.indexOf(job);
      if (index >= 0) { this.#queue.splice(index, 1); job.reject(new Error("Plugin package loading timed out in queue.")); }
    }, this.#timeoutMs);
    this.#queue.push(job); this.#drain();
    return promise as Promise<LoadedPluginPackage | PluginProfile>;
  }

  snapshot() {
    return Object.freeze({ accepting: !this.#disposed, active: this.#active.size, queued: this.#queue.length,
      workerPids: [...this.#children].flatMap(child => child.pid === undefined ? [] : [child.pid]),
      maxConcurrency: this.#maxConcurrency, maxQueue: this.#maxQueue, timeoutMs: this.#timeoutMs });
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    for (const job of this.#queue.splice(0)) { clearTimeout(job.queueTimer); job.reject(new Error("Plugin package catalog stopped before loading began.")); }
    for (const job of this.#active) {
      job.cancelled = new Error("Plugin package catalog stopped during loading.");
      job.stop?.();
    }
    this.#disposal = Promise.allSettled([...this.#active].map(job => job.closed)).then(() => undefined);
    return this.#disposal;
  }

  #drain(): void {
    while (!this.#disposed && this.#active.size < this.#maxConcurrency && this.#queue.length) {
      const job = this.#queue.shift()!;
      clearTimeout(job.queueTimer);
      this.#active.add(job);
      const released = () => { this.#active.delete(job); this.#drain(); };
      job.closed = this.#run(job).then(value => { released(); job.resolve(value); }, error => { released(); job.reject(error); });
    }
  }

  async #run(job: Job): Promise<LoadedPluginPackage | PluginProfile | undefined> {
    try {
      if (Date.now() >= job.deadlineAt) throw new Error("Plugin package loading timed out before worker dispatch.");
      const result = await this.#worker(job, { id: job.id, task: job.task }, job.deadlineAt, this.options.workerURL);
      if (job.cancelled) throw job.cancelled;
      return freeze(result);
    } catch (error) {
      let failure = error instanceof Error ? error : new Error(String(error));
      if (job.task.kind === "package") {
        // The terminated child can leave only its unique, unpublished staging tree.
        // Cleanup is isolated too: a stuck filesystem must not strand the Manager.
        try {
          await this.#worker(job, { id: job.id, task: { kind: "cleanup", runtimeRoot: job.task.runtimeRoot, stagingId: job.id } },
            Date.now() + this.#cleanupTimeoutMs);
        } catch (cleanupError) {
          failure = new Error(`${failure.message} Staging cleanup was not completed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
      throw failure;
    }
  }

  #worker(job: Job, request: PluginPackageLoadRequest, deadlineAt: number, override?: URL): Promise<LoadedPluginPackage | PluginProfile | undefined> {
    const source = import.meta.url.endsWith(".ts");
    const worker = override ?? new URL(source ? "./pluginPackageLoadWorker.ts" : "./pluginPackageLoadWorker.js", import.meta.url);
    const child = fork(fileURLToPath(worker), [], { execArgv: source ? ["--import", "tsx"] : [],
      env: workerEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", ...{ windowsHide: true } });
    this.#children.add(child);
    return new Promise((resolve, reject) => {
      let reply: PluginPackageLoadReply | undefined;
      let failure: Error | undefined;
      let terminationRequested = false;
      const stop = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
        catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
      };
      job.stop = stop;
      const timer = setTimeout(() => {
        failure = new Error(request.task.kind === "cleanup" ? "Plugin package staging cleanup timed out." : "Plugin package loading timed out.");
        stop();
      }, Math.max(1, deadlineAt - Date.now()));
      child.on("message", (value: PluginPackageLoadReply) => {
        if (failure || job.cancelled && request.task.kind !== "cleanup") return;
        if (value?.id !== request.id || typeof value.ok !== "boolean") { failure = new Error("Plugin package worker returned an invalid reply."); stop(); return; }
        reply = value;
      });
      child.once("error", error => { failure ??= error; stop(); });
      child.once("close", (code, signal) => {
        clearTimeout(timer); this.#children.delete(child);
        if (job.stop === stop) job.stop = undefined;
        const cancelled = request.task.kind !== "cleanup" ? job.cancelled : undefined;
        if (cancelled || failure) { reject(cancelled ?? failure); return; }
        if (code !== 0 || signal || !reply) { reject(new Error(`Plugin package worker closed without confirmation (${code ?? signal ?? "no reply"}).`)); return; }
        if (!reply.ok) { reject(new Error(reply.error)); return; }
        resolve(reply.value);
      });
      try { child.send(request, error => { if (error) { failure ??= error; stop(); } }); }
      catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); stop(); }
    });
  }
}
