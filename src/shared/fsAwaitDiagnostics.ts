import { performance } from "node:perf_hooks";
import { currentOperationContext } from "../observability/dataMutationAudit.js";

export type SlowFsDiagnostic = Readonly<{
  owner: string; operation: string; phase: string; requestId?: string;
  operationElapsedMs: number; phaseElapsedMs: number; pid: number;
  pendingFsCount: number; activeRequestConstructors: Readonly<Record<string, number>>;
}>;
export type SlowFsReporter = (diagnostic: SlowFsDiagnostic) => void;
const slowFsAwaitMs = 2000;

function activeRequestConstructors(): Record<string, number> {
  const counts: Record<string, number> = {};
  // Node exposes no public request census; this optional diagnostic never gates business work.
  const requests = (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() ?? [];
  for (const request of requests) {
    const name = (request as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** One timer and only pending awaits, owned by one actual operation; no global registry. */
export class FsAwaitDiagnostics {
  private readonly started = performance.now();
  private readonly requestId = currentOperationContext()?.requestId;
  private readonly pending = new Map<object, { phase: string; started: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private reported = false;

  constructor(private readonly owner: string, private readonly operation: string, private readonly report: SlowFsReporter) {}

  private schedulePending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.reported) return;
    const first = this.pending.values().next().value;
    if (!first) return;
    const remainingMs = Math.max(1, slowFsAwaitMs - (performance.now() - first.started));
    this.timer = setTimeout(() => this.reportPending(), remainingMs);
    this.timer.unref();
  }

  private reportPending(): void {
    this.timer = undefined;
    if (this.reported) return;
    const first = this.pending.values().next().value;
    if (!first) return;
    // Timer scheduling and phase changes must never turn a fresh await into a stall.
    if (performance.now() - first.started < slowFsAwaitMs) { this.schedulePending(); return; }
    this.reported = true;
    try {
      const now = performance.now();
      this.report({ owner: this.owner, operation: this.operation, phase: first.phase, requestId: this.requestId,
        operationElapsedMs: Math.round(now - this.started), phaseElapsedMs: Math.round(now - first.started),
        pid: process.pid, pendingFsCount: this.pending.size, activeRequestConstructors: activeRequestConstructors() });
    } catch { /* Diagnostic failures must preserve the original operation result. */ }
  }

  async wait<T>(phase: string, work: Promise<T>): Promise<T> {
    const token = {};
    this.pending.set(token, { phase, started: performance.now() });
    if (!this.timer) this.schedulePending();
    try { return await work; }
    finally {
      this.pending.delete(token);
      this.schedulePending();
    }
  }

  finish(): void {
    // An HTTP abort is not completion of an outstanding filesystem request.
    if (this.pending.size === 0) this.schedulePending();
  }
}

export function traceFsAwait<T>(scope: FsAwaitDiagnostics | undefined, phase: string, work: Promise<T>): Promise<T> {
  return scope ? scope.wait(phase, work) : work;
}
