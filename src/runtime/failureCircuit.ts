import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type FailureCircuitPhase = "backoff" | "incident";

export type FailureCircuitSnapshot = Readonly<{
  key: string;
  phase: FailureCircuitPhase;
  signature: string;
  consecutiveFailures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  retryAt: number;
  incidentId?: string;
}>;

export type FailureCircuitDecision = Readonly<{
  snapshot: FailureCircuitSnapshot;
  delayMs: number;
  shouldReport: boolean;
  incidentOpened: boolean;
}>;

export type FailureCircuitSummary = Readonly<{
  backoff: number;
  incidents: number;
  nextRetryAt?: number;
}>;

export type FailureCircuitOptions = {
  baseDelayMs: number;
  maximumDelayMs: number;
  incidentThreshold: number;
  reportIntervalMs?: number;
  now?: () => number;
  persistencePath?: string;
  onPersistenceError?: (error: unknown) => void;
};

type MutableFailureState = {
  signature: string;
  consecutiveFailures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  retryAt: number;
  lastReportedAt: number;
  incidentId?: string;
};

function normalizedError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error ? String((error as NodeJS.ErrnoException).code || "") : "";
    return `${error.name}\u001f${code}\u001f${error.message}`
      .replace(/[A-Za-z]:[\\/][^\s;]+/g, "<path>")
      .replace(/\\\\[^\s;]+/g, "<unc>");
  }
  return String(error);
}

export function failureSignature(error: unknown): string {
  return createHash("sha256").update(normalizedError(error)).digest("hex").slice(0, 24);
}

function snapshot(key: string, state: MutableFailureState, incidentThreshold: number): FailureCircuitSnapshot {
  return Object.freeze({
    key,
    phase: state.consecutiveFailures >= incidentThreshold ? "incident" : "backoff",
    signature: state.signature,
    consecutiveFailures: state.consecutiveFailures,
    firstFailureAt: state.firstFailureAt,
    lastFailureAt: state.lastFailureAt,
    retryAt: state.retryAt,
    ...(state.incidentId ? { incidentId: state.incidentId } : {})
  });
}

export class FailureCircuitRegistry {
  private readonly states = new Map<string, MutableFailureState>();
  private readonly baseDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly incidentThreshold: number;
  private readonly reportIntervalMs: number;
  private readonly now: () => number;
  private readonly persistencePath?: string;
  private persistenceErrorReported = false;

  constructor(options: FailureCircuitOptions) {
    this.baseDelayMs = Math.max(1, options.baseDelayMs);
    this.maximumDelayMs = Math.max(this.baseDelayMs, options.maximumDelayMs);
    this.incidentThreshold = Math.max(2, options.incidentThreshold);
    this.reportIntervalMs = Math.max(this.baseDelayMs, options.reportIntervalMs ?? this.maximumDelayMs);
    this.now = options.now ?? Date.now;
    this.persistencePath = options.persistencePath;
    this.restore(options.onPersistenceError);
    this.onPersistenceError = options.onPersistenceError;
  }

  private readonly onPersistenceError?: (error: unknown) => void;

  private storageKey(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  canAttempt(key: string): boolean {
    const state = this.states.get(this.storageKey(key));
    return !state || this.now() >= state.retryAt;
  }

  nextRetryAt(key: string): number | undefined {
    return this.states.get(this.storageKey(key))?.retryAt;
  }

  recordFailure(key: string, error: unknown): FailureCircuitDecision {
    const at = this.now();
    const signature = failureSignature(error);
    const exactKey = this.storageKey(key);
    const previous = this.states.get(exactKey);
    const state = previous?.signature === signature
      ? previous
      : {
          signature,
          consecutiveFailures: 0,
          firstFailureAt: at,
          lastFailureAt: at,
          retryAt: at,
          lastReportedAt: 0
        };
    state.consecutiveFailures += 1;
    state.lastFailureAt = at;
    const exponent = Math.min(30, state.consecutiveFailures - 1);
    const delayMs = Math.min(this.maximumDelayMs, this.baseDelayMs * (2 ** exponent));
    state.retryAt = at + delayMs;
    const incidentOpened = state.consecutiveFailures === this.incidentThreshold;
    if (incidentOpened) {
      state.incidentId = createHash("sha256")
        .update(`${key}\u001f${signature}\u001f${state.firstFailureAt}`)
        .digest("hex")
        .slice(0, 24);
    }
    const shouldReport = state.consecutiveFailures === 1
      || incidentOpened
      || at - state.lastReportedAt >= this.reportIntervalMs;
    if (shouldReport) state.lastReportedAt = at;
    this.states.set(exactKey, state);
    this.persist();
    return Object.freeze({
      snapshot: snapshot(key, state, this.incidentThreshold),
      delayMs,
      shouldReport,
      incidentOpened
    });
  }

  recordSuccess(key: string): void {
    if (this.states.delete(this.storageKey(key))) this.persist();
  }

  reset(key?: string): void {
    const changed = key === undefined
      ? this.states.size > 0
      : this.states.delete(this.storageKey(key));
    if (key === undefined) this.states.clear();
    if (changed) this.persist();
  }

  retain(keys: Iterable<string>): void {
    const retained = new Set([...keys].map(key => this.storageKey(key)));
    let changed = false;
    for (const key of this.states.keys()) {
      if (retained.has(key)) continue;
      this.states.delete(key);
      changed = true;
    }
    if (changed) this.persist();
  }

  inspect(key: string): FailureCircuitSnapshot | undefined {
    const state = this.states.get(this.storageKey(key));
    return state ? snapshot(key, state, this.incidentThreshold) : undefined;
  }

  summary(): FailureCircuitSummary {
    let backoff = 0;
    let incidents = 0;
    let nextRetryAt: number | undefined;
    for (const state of this.states.values()) {
      if (state.consecutiveFailures >= this.incidentThreshold) incidents += 1;
      else backoff += 1;
      nextRetryAt = Math.min(nextRetryAt ?? Number.POSITIVE_INFINITY, state.retryAt);
    }
    return Object.freeze({
      backoff,
      incidents,
      ...(nextRetryAt !== undefined && Number.isFinite(nextRetryAt) ? { nextRetryAt } : {})
    });
  }

  private restore(onError?: (error: unknown) => void): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as {
        schemaVersion?: unknown;
        states?: unknown;
      };
      if (parsed.schemaVersion !== 1 || !parsed.states || typeof parsed.states !== "object") {
        throw new Error("Failure circuit state schema is invalid.");
      }
      for (const [key, value] of Object.entries(parsed.states as Record<string, MutableFailureState>)) {
        if (!/^[a-f0-9]{32}$/.test(key)
          || !value
          || typeof value.signature !== "string"
          || !Number.isFinite(value.consecutiveFailures)
          || !Number.isFinite(value.firstFailureAt)
          || !Number.isFinite(value.lastFailureAt)
          || !Number.isFinite(value.retryAt)
          || !Number.isFinite(value.lastReportedAt)) continue;
        this.states.set(key, value);
      }
    } catch (error) {
      onError?.(error);
      this.persistenceErrorReported = true;
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const temporaryPath = `${this.persistencePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date(this.now()).toISOString(),
        states: Object.fromEntries(this.states)
      })}\n`, "utf8");
      fs.renameSync(temporaryPath, this.persistencePath);
      recordDataMutationAudit({
        group: "runtime",
        event: "failure_circuit_state_written",
        owner: "failure-circuit",
        action: "persist-state",
        target: { type: "failure-circuit", id: path.basename(this.persistencePath) },
        dataSource: { kind: "file", id: path.basename(this.persistencePath) },
        outcome: "committed",
        changes: [{ field: "stateCount", to: this.states.size }]
      });
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "runtime",
        event: "failure_circuit_state_write_failed",
        owner: "failure-circuit",
        action: "persist-state",
        target: { type: "failure-circuit", id: path.basename(this.persistencePath) },
        dataSource: { kind: "file", id: path.basename(this.persistencePath) },
        outcome: "failed",
        error
      });
      if (!this.persistenceErrorReported) {
        this.persistenceErrorReported = true;
        this.onPersistenceError?.(error);
      }
    }
  }
}
