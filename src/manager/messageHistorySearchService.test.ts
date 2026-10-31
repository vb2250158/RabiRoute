import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { queryMessageHistory, stopMessageHistorySearch } from "./messageHistorySearchService.js";
import { managerMessageIndexWorkerPool, managerMessageSearchWorkerPool, ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import type { ManagerReadWorkerTask } from "./managerReadWorkerTasks.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";
import { publishMessageHistoryChange } from "../messageHistoryChanges.js";

test("a timed-out background build resumes without another user query and stop cancels retries", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => { throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY"); });
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => {
    attempts++;
    throw new ManagerReadWorkerError("synthetic indexing deadline", "timeout");
  });
  await assert.rejects(queryMessageHistory("synthetic-role", { limit: 10 }, { signal: new AbortController().signal }), /NOT_READY/);
  await setImmediate(); assert.equal(attempts, 1);
  t.mock.timers.tick(2_000); await setImmediate(); assert.equal(attempts, 2);
  stopMessageHistorySearch();
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(attempts, 2);
});

test("successful catch-up yields after eight passes without failure backoff", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let builds = 0;
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => { throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY"); });
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => {
    await setImmediate(); builds++;
    if (builds <= 8) publishMessageHistoryChange("synthetic-continuous-catchup");
    return {};
  });
  await assert.rejects(queryMessageHistory("synthetic-continuous-catchup", { limit: 10 }, { signal: new AbortController().signal }), /NOT_READY/);
  for (let i = 0; i < 12; i++) await setImmediate();
  assert.equal(builds, 8);
  t.mock.timers.tick(0); await setImmediate(); await setImmediate();
  assert.equal(builds, 9);
});

test("source changes on the last catch-up pass retry promptly without failure backoff", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let builds = 0;
  const role = "synthetic-last-pass-source-change";
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => { throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY"); });
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => {
    await setImmediate(); builds++;
    if (builds < 8) publishMessageHistoryChange(role);
    if (builds === 8) throw new Error("MESSAGE_HISTORY_INDEX_LAGGING: source changed during capture");
    return {};
  });
  await assert.rejects(queryMessageHistory(role, { limit: 10 }, { signal: new AbortController().signal }), /NOT_READY/);
  for (let i = 0; i < 12; i++) await setImmediate();
  assert.equal(builds, 8);
  t.mock.timers.tick(24); await setImmediate(); assert.equal(builds, 8);
  t.mock.timers.tick(1); await setImmediate(); await setImmediate(); assert.equal(builds, 9);
  stopMessageHistorySearch(); t.mock.timers.tick(60_000); await setImmediate(); assert.equal(builds, 9);
});

test("visibility retries keep the first target while newer commits arrive", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  const target = { guards: { current: "initial" } };
  let calls = 0;
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => ({}));
  t.mock.method(managerMessageSearchWorkerPool, "run", async (task: ManagerReadWorkerTask) => {
    assert.equal(task.type, "message_history_search"); if (task.type !== "message_history_search") return;
    calls++;
    if (calls > 1) assert.equal(task.target, target);
    if (calls < 3) return { ready: false, reason: "MESSAGE_HISTORY_INDEX_LAGGING", target: calls === 1 ? target : { guards: { current: "newer" } } };
    return { ready: true, result: { entries: [], coverage: { indexVersion: "index", sourceVersion: "target", indexedAt: "now", sourceSnapshotIndexed: true },
      metrics: { strategy: "ordered", candidates: 0, elapsedMs: 1 } } };
  });
  const result = await queryMessageHistory("synthetic-frozen-target", { limit: 10 }, { signal: new AbortController().signal });
  assert.equal(result.coverage.sourceVersion, "target"); assert.equal(calls, 3);
});

test("an in-flight build wakes visibility without redundant probes or another indexing pass", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  let resolveBuild!: (value: unknown) => void;
  let builds = 0; let probes = 0;
  t.mock.method(managerMessageIndexWorkerPool, "run", () => { builds++; return new Promise(resolve => { resolveBuild = resolve; }); });
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => ++probes < 2
    ? { ready: false, reason: "MESSAGE_HISTORY_INDEX_LAGGING", target: { guards: { current: "target" } } }
    : { ready: true, result: { entries: [], coverage: { indexVersion: "index", sourceVersion: "target", indexedAt: "now", sourceSnapshotIndexed: true },
      metrics: { strategy: "ordered", candidates: 0, elapsedMs: 1 } } });
  const query = queryMessageHistory("synthetic-coalesced-probes", { limit: 10 }, { signal: new AbortController().signal });
  await setImmediate(); assert.equal(probes, 1);
  resolveBuild({}); await query;
  assert.equal(probes, 2); assert.equal(builds, 1);
});

test("a target that does not become visible stops waiting within the source barrier", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  const acquisitionMs = 250;
  let now = 0;
  let visibilityBegan = 0;
  let calls = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => ({}));
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => {
    // Source acquisition precedes the visibility budget; later probes consume it.
    now += 250;
    if (++calls === 1) visibilityBegan = now;
    return { ready: false, reason: "MESSAGE_HISTORY_INDEX_LAGGING", target: { guards: { current: String(calls) } } };
  });
  const began = performance.now();
  await assert.rejects(queryMessageHistory("synthetic-lag-budget", { limit: 10 }, { signal: new AbortController().signal }),
    error => error instanceof ManagerReadWorkerError && error.code === "busy" && error.message === "MESSAGE_HISTORY_INDEX_LAGGING");
  assert.equal(visibilityBegan - began, acquisitionMs);
  assert.equal(performance.now() - visibilityBegan, 1500);
  assert.equal(performance.now() - began, acquisitionMs + 1500);
  assert.ok(calls > 1);
});

test("periodic reconciliation wakes a known role even if no commit notification arrives", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let builds = 0;
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => { builds++; return {}; });
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => ({ ready: true, result: { entries: [],
    coverage: { indexVersion: "index", sourceVersion: "source", indexedAt: "now", sourceSnapshotIndexed: true },
    metrics: { strategy: "ordered", candidates: 0, elapsedMs: 1 } } }));
  await queryMessageHistory("synthetic-missed-notification", { limit: 10 }, { signal: new AbortController().signal });
  assert.equal(builds, 0);
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(builds, 1);
  stopMessageHistorySearch(); t.mock.timers.tick(120_000); await setImmediate(); assert.equal(builds, 1);
});

test("the visibility stage cannot reset the original request deadline", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  t.mock.method(managerMessageIndexWorkerPool, "run", async () => ({}));
  t.mock.method(managerMessageSearchWorkerPool, "run", async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { ready: false, reason: "MESSAGE_HISTORY_INDEX_LAGGING", target: { guards: { current: "target" } } };
  });
  const began = performance.now();
  await assert.rejects(queryMessageHistory("synthetic-shared-deadline", { limit: 10 },
    { signal: new AbortController().signal, deadlineAt: began + 80 }), /LAGGING|DEADLINE/);
  assert.ok(performance.now() - began < 180);
});

test("query traces correlate request stages without recording search text or message bodies", async t => {
  stopMessageHistorySearch(); t.after(stopMessageHistorySearch);
  const records: RecordedDataMutationAudit[] = [];
  const uninstall = installDataMutationAuditSink(record => { if (record.group === "message-search") records.push(record); });
  t.after(uninstall);
  t.mock.method(managerMessageSearchWorkerPool, "run", async (_task: unknown, options: { onStarted?: (ms: number) => void }) => {
    options.onStarted?.(12);
    return { ready: true, result: { entries: [{ text: "private-message-marker" }],
      coverage: { indexVersion: "index", sourceVersion: "source", indexedAt: "now", sourceSnapshotIndexed: true },
      metrics: { strategy: "ordered", candidates: 3, elapsedMs: 5, snapshotMs: 1, projectionMs: 1, candidateMs: 3 } } };
  });
  await queryMessageHistory("synthetic-private-marker", { limit: 10, query: "private-query-marker" },
    { signal: new AbortController().signal, requestId: "synthetic-request" });
  assert.equal(records.length, 1); assert.equal(records[0].requestId, "synthetic-request");
  assert.equal(records[0].changes?.find(change => change.field === "queueMs")?.to, 12);
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("private-message-marker"), false);
  assert.equal(serialized.includes("private-query-marker"), false);
  assert.equal(serialized.includes("synthetic-private-marker"), false);
});
