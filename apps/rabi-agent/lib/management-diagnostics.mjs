import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const OPERATIONS = new Set(["prepared_delivery", "reconcile_prepared_delivery"]);
const STAGES = new Set(["received", "queue_enter", "receipt_wait", "receipt_enter", "module", "authority", "receipt_read", "receipt_recovery", "receipt_write", "attempt", "not_sent_read", "not_sent_write", "execute", "response"]);
const RESULTS = new Set(["started", "completed", "failed", "sent", "not_sent", "connection_changed"]);
const NO_TRACE = Object.freeze({ mark() {}, run: (_stage, operation) => operation() });

/** Bounded diagnostic snapshot, never delivery evidence or a source of authority. */
export class ManagementDiagnostics {
  constructor(filePath) { this.filePath = filePath; this.entries = []; }

  begin({ requestId, operation, deliveryId }) {
    if (!OPERATIONS.has(operation) || typeof requestId !== "string" || !/^[\w-]{1,100}$/.test(requestId)
      || typeof deliveryId !== "string" || !/^[\w-]{1,100}$/.test(deliveryId)) return NO_TRACE;
    const started = performance.now();
    const entry = { requestId, deliveryId, operation, startedAt: new Date().toISOString(), elapsedMs: 0, stages: {} };
    this.entries.push(entry);
    if (this.entries.length > 16) this.entries.shift();
    const mark = (stage, result = "started", durationMs) => {
      if (!STAGES.has(stage) || !RESULTS.has(result)) return;
      entry.elapsedMs = Math.round(performance.now() - started);
      entry.stage = stage;
      const value = entry.stages[stage] ||= { count: 0, elapsedMs: 0 };
      if (result === "started") value.count++;
      value.result = result;
      value.atMs = entry.elapsedMs;
      if (durationMs !== undefined) value.elapsedMs += Math.round(durationMs);
      this.persist();
    };
    mark("received");
    return { mark, run: async (stage, operation) => {
      const start = performance.now(); mark(stage);
      try { const result = await operation(); mark(stage, "completed", performance.now() - start); return result; }
      catch (error) { mark(stage, "failed", performance.now() - start); throw error; }
    } };
  }

  persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, diagnosticOnly: true, entries: this.entries }), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch {
      // A diagnostic failure must not change the original operation or receipt.
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}
