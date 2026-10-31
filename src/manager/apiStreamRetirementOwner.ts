import { Readable } from "node:stream";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS, runPluginSynchronousWork } from "../plugin-kernel/synchronousExecution.js";
import type { ApiOperationStream } from "./apiOperationContract.js";

type PhaseResult<T> = { state: "returned"; value: T } | { state: "rejected"; error: unknown } | { state: "unconfirmed"; error: unknown };
export type ApiStreamRetirementSnapshot = Readonly<{
  instanceId: string; operationId: string; activationId?: string;
  state: "owned" | "retiring" | "retired" | "unconfirmed";
  streamCaptured: boolean; iteratorCaptured: boolean;
  cancellation: "not_started" | "pending" | "fulfilled" | "rejected" | "unconfirmed";
  iteration: "not_started" | "pending" | "eof" | "native_readable_closed" | "unconfirmed";
  unconfirmedPhases: readonly string[];
}>;

/** Owns one accepted resource's retirement proof, including partial/unconfirmed acknowledgements. */
export class ApiStreamRetirementOwner {
  readonly completion: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private started = false;
  private finished = false;
  private state: ApiStreamRetirementSnapshot["state"] = "owned";
  private cancellation: ApiStreamRetirementSnapshot["cancellation"] = "not_started";
  private iteration: ApiStreamRetirementSnapshot["iteration"] = "not_started";
  private iteratorCaptured = false;
  private readonly unconfirmedPhases = new Set<string>();
  private firstFailure?: unknown;
  private hasFailure = false;
  private frames?: AsyncIterable<unknown>;
  private readonly timeoutMs: number;

  constructor(private readonly source: ApiOperationStream | undefined, private readonly identity: { instanceId: string; operationId: string; activationId?: string },
    options: { synchronousTimeoutMs?: number; captureUnconfirmed?: boolean } = {}) {
    this.timeoutMs = options.synchronousTimeoutMs ?? DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS;
    this.completion = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.completion.catch(() => undefined);
    // This gate belongs to this concrete result/resource. It resolves only from
    // actual cancellation/terminal observations below, never from a timeout.
    if (options.captureUnconfirmed) this.markUnconfirmed("result.stream");
  }

  snapshot(): ApiStreamRetirementSnapshot {
    return { ...this.identity, state: this.state, streamCaptured: Boolean(this.source), iteratorCaptured: this.iteratorCaptured,
      cancellation: this.cancellation, iteration: this.iteration, unconfirmedPhases: [...this.unconfirmedPhases] };
  }

  retire(reason: unknown): Promise<void> {
    if (this.started) return this.completion;
    this.started = true;
    if (!this.source) {
      if (!this.unconfirmedPhases.size) { this.state = "retired"; this.finished = true; this.resolve(); }
      return this.completion;
    }
    if (!this.unconfirmedPhases.size) this.state = "retiring";
    // The coordinator and its observable completion already exist before any
    // getter inspection can be interrupted by the computation guard. Resource
    // owner calls retain their original transaction/finally and actual join.
    queueMicrotask(() => {
      try { this.begin(reason); }
      catch (error) { this.recordFailure(error); this.markUnconfirmed("coordinator"); }
    });
    return this.completion;
  }

  private protectedPhase<T>(phase: string, operation: () => T): PhaseResult<T> {
    let returned = false, rejected = false;
    let failure: unknown;
    try {
      const value = runPluginSynchronousWork(() => {
        try { const result = operation(); returned = true; return result; }
        catch (error) { failure = error; rejected = true; returned = true; throw error; }
      }, "API stream retirement " + phase + " " + this.identity.operationId, this.timeoutMs);
      return { state: "returned", value };
    } catch (error) {
      if (returned && rejected) return { state: "rejected", error: failure };
      this.markUnconfirmed(phase);
      return { state: "unconfirmed", error };
    }
  }

  private begin(reason: unknown): void {
    const factory = this.protectedPhase("iterator.capture", () => {
      this.frames = this.source!.frames;
      return this.frames[Symbol.asyncIterator];
    });
    const acquired = factory.state === "returned"
      ? this.ownerPhase(() => factory.value.call(this.frames)) : factory;
    let iterator: AsyncIterator<unknown> | undefined;
    if (acquired.state === "returned") { iterator = acquired.value; this.iteratorCaptured = true; this.iteration = "pending"; }
    else { this.recordFailure(acquired.error); this.iteration = "unconfirmed"; this.markUnconfirmed("iterator.acquire"); }

    // Getter inspection is computation. Calling the trusted resource owner must
    // let its transaction/finally complete, including a slow synchronous prefix.
    const cancel = this.protectedPhase("cancel.capture", () => this.source!.cancel);
    const cancelled = cancel.state === "returned"
      ? this.ownerPhase(() => Promise.resolve(cancel.value.call(this.source, reason))) : cancel;
    if (cancelled.state === "returned") {
      this.cancellation = "pending";
      void cancelled.value.then(() => { this.cancellation = "fulfilled"; this.finishIfProven(); }, error => {
        this.recordFailure(error); this.cancellation = "rejected"; this.finishIfProven();
      });
    } else if (cancelled.state === "rejected") {
      this.recordFailure(cancelled.error); this.cancellation = "rejected";
    } else {
      this.recordFailure(cancelled.error); this.cancellation = "unconfirmed";
    }
    if (iterator) void this.drain(iterator).catch(error => { this.recordFailure(error); this.iteration = "unconfirmed"; this.markUnconfirmed("iterator.driver"); });
    this.finishIfProven();
  }

  private async drain(iterator: AsyncIterator<unknown>): Promise<void> {
    let consecutiveErrors = 0, steps = 0;
    for (;;) {
      if (++steps % 32 === 0) await yieldImmediate();
      const next = this.protectedPhase("iterator.next.capture", () => iterator.next);
      const entered = next.state === "returned"
        ? this.ownerPhase(() => Promise.resolve(next.value.call(iterator))) : next;
      if (entered.state === "unconfirmed") { this.recordFailure(entered.error); this.iteration = "unconfirmed"; return; }
      let result: IteratorResult<unknown>;
      try {
        if (entered.state === "rejected") throw entered.error;
        result = await entered.value;
      } catch (error) {
        this.recordFailure(error);
        const nativeClosed = this.protectedPhase("readable.closed", () => this.frames instanceof Readable && this.frames.closed && this.frames.destroyed);
        if (nativeClosed.state === "returned" && nativeClosed.value) { this.iteration = "native_readable_closed"; this.finishIfProven(); return; }
        if (nativeClosed.state !== "returned" || ++consecutiveErrors > 1) { this.iteration = "unconfirmed"; this.markUnconfirmed("iterator.terminal"); return; }
        // A generator whose next rejected may already have finished. One
        // subsequent next observes EOF; it never replays a business request.
        continue;
      }
      const terminal = this.protectedPhase("iterator.done", () => Boolean(result.done));
      if (terminal.state !== "returned") { this.recordFailure(terminal.error); this.iteration = "unconfirmed"; this.markUnconfirmed("iterator.done"); return; }
      if (terminal.value) { this.iteration = "eof"; this.finishIfProven(); return; }
      consecutiveErrors = 0;
      // Cleanup frames are discarded, without reading their value/getters.
    }
  }

  private recordFailure(error: unknown): void {
    if (this.hasFailure) return;
    this.hasFailure = true;
    this.firstFailure = error;
  }

  private ownerPhase<T>(operation: () => T): PhaseResult<T> {
    try { return { state: "returned", value: operation() }; }
    catch (error) { return { state: "rejected", error }; }
  }

  private markUnconfirmed(phase: string): void {
    this.unconfirmedPhases.add(phase);
    this.state = "unconfirmed";
  }

  private finishIfProven(): void {
    if (this.finished || this.unconfirmedPhases.size) return;
    if (this.cancellation !== "fulfilled" && this.cancellation !== "rejected") return;
    if (this.iteration !== "eof" && this.iteration !== "native_readable_closed") return;
    this.finished = true; this.state = "retired";
    if (this.hasFailure) this.reject(this.firstFailure);
    else this.resolve();
  }
}
