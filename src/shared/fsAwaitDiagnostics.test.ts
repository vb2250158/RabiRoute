import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { FsAwaitDiagnostics, traceFsAwait, type SlowFsDiagnostic } from "./fsAwaitDiagnostics.js";
import { createOperationContext, runWithOperationContext } from "../observability/dataMutationAudit.js";

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function clock(t: test.TestContext): (ms: number) => void {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

test("disabled tracing preserves the original promise and fast completion never reports", async t => {
  const advance = clock(t);
  const original = Promise.resolve(7);
  assert.equal(traceFsAwait(undefined, "read", original), original);
  let reports = 0;
  const scope = new FsAwaitDiagnostics("fixture", "fast", () => reports++);
  assert.equal(await scope.wait("read", original), 7); scope.finish();
  advance(10000); assert.equal(reports, 0);
});

test("one overdue report identifies first unfinished parallel await and retains request context after cancellation", async t => {
  const advance = clock(t);
  const reports: SlowFsDiagnostic[] = [];
  const scope = runWithOperationContext(createOperationContext({ source: "http", actor: { kind: "system" }, requestId: "fixture-request" }),
    () => new FsAwaitDiagnostics("fixture", "snapshot", row => reports.push(row)));
  const first = deferred<number>(), second = deferred<number>();
  const a = scope.wait("first.read", first.promise), b = scope.wait("second.read", second.promise);
  first.resolve(1); await a;
  // Request cancellation may finish an outer handler while the real filesystem work remains pending.
  scope.finish(); advance(2000);
  assert.equal(reports.length, 1); assert.equal(reports[0]!.phase, "second.read");
  assert.equal(reports[0]!.requestId, "fixture-request"); assert.equal(reports[0]!.pendingFsCount, 1);
  assert.equal(reports[0]!.pid, process.pid); assert.equal(typeof reports[0]!.activeRequestConstructors, "object");
  assert.equal(Object.keys(reports[0]!).some(key => /path|content|credential/i.test(key)), false);
  advance(10000); assert.equal(reports.length, 1);
  second.resolve(2); assert.equal(await b, 2); scope.finish();
  advance(10000); assert.equal(reports.length, 1);
});

test("a throwing reporter preserves original failure and successful release", async t => {
  const advance = clock(t);
  let calls = 0;
  const scope = new FsAwaitDiagnostics("fixture", "failure", () => { calls++; throw new Error("report failed"); });
  const work = deferred<number>(); const expected = new Error("original failure");
  const result = scope.wait("read", work.promise); const rejected = assert.rejects(result, error => error === expected);
  advance(2000); assert.equal(calls, 1); work.reject(expected); await rejected; scope.finish();
  assert.equal(await scope.wait("release", Promise.resolve(3)), 3); scope.finish();
  advance(10000); assert.equal(calls, 1);
});


test("an old operation's fast read stays silent and a later genuinely stalled phase still reports", async t => {
  const advance = clock(t), reports: SlowFsDiagnostic[] = [];
  const scope = new FsAwaitDiagnostics("fixture", "backpressure", row => reports.push(row));
  advance(2100);
  assert.equal(await scope.wait("fast.read", Promise.resolve(1)), 1);
  assert.equal(reports.length, 0);
  const work = deferred<number>(); const result = scope.wait("blocked.read", work.promise);
  advance(1999); assert.equal(reports.length, 0);
  advance(1); assert.equal(reports.length, 1);
  assert.equal(reports[0]!.phase, "blocked.read"); assert.equal(reports[0]!.phaseElapsedMs, 2000);
  assert.equal(reports[0]!.operationElapsedMs, 4100);
  work.resolve(2); assert.equal(await result, 2); scope.finish();
  advance(10000); assert.equal(reports.length, 1);
});

test("completion of the oldest parallel phase rearms against the next phase's own age", async t => {
  const advance = clock(t), reports: SlowFsDiagnostic[] = [];
  const scope = new FsAwaitDiagnostics("fixture", "parallel", row => reports.push(row));
  const first = deferred<number>(), second = deferred<number>();
  const a = scope.wait("first.read", first.promise); advance(1500);
  const b = scope.wait("second.read", second.promise); first.resolve(1); await a;
  advance(500); assert.equal(reports.length, 0);
  advance(1499); assert.equal(reports.length, 0);
  advance(1); assert.equal(reports.length, 1); assert.equal(reports[0]!.phaseElapsedMs, 2000);
  second.resolve(2); await b; scope.finish();
});
