import assert from "node:assert/strict";
import test from "node:test";
import { EffectScope } from "./effectScope.js";

test("completed lifecycle phases yield to independent event-loop work", async () => {
  const scope = new EffectScope();
  let completed = 0;
  const phases = (async () => {
    for (let index = 0; index < 50; index++) await scope.run("short phase", () => { completed++; });
  })();
  const observed = await new Promise<number>(resolve => setImmediate(() => resolve(completed)));
  await phases;
  assert.ok(observed < 50, `All ${completed} phases completed before independent work could run.`);
  assert.equal(completed, 50);
  await scope.dispose();
});

test("cancellation before a scheduled phase prevents its owner from starting", async () => {
  const scope = new EffectScope();
  let calls = 0;
  const operation = scope.run("cancelled phase", () => { calls++; });
  scope.abort(new Error("cancel before admission"));
  await assert.rejects(operation, /cancel before admission/);
  assert.equal(calls, 0);
  await scope.dispose();
  assert.equal(scope.retirementConfirmed(), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("a falsy disposer failure cannot be mistaken for confirmed retirement", async () => {
  const scope = new EffectScope();
  scope.adopt(() => { throw undefined; }, "falsy failure fixture");
  await assert.rejects(scope.dispose(), /retirement is unconfirmed/);
  assert.equal(scope.retirementConfirmed(), false);
});

test("EffectScope aborts before reverse-order disposal and includes adopted resources", async () => {
  const scope = new EffectScope();
  const lifecycle: string[] = [];
  scope.adopt(() => { lifecycle.push(`adopted:${scope.signal().aborted}`); });
  scope.add(() => {
    lifecycle.push("start:first");
    return () => { lifecycle.push(`stop:first:${scope.signal().aborted}`); };
  });
  scope.add(() => {
    lifecycle.push("start:second");
    return () => { lifecycle.push(`stop:second:${scope.signal().aborted}`); };
  });
  await scope.commit();
  await scope.dispose();
  assert.deepEqual(lifecycle, [
    "start:first", "start:second", "stop:second:true", "stop:first:true", "adopted:true"
  ]);
});

test("EffectScope releases adopted resources when commit fails", async () => {
  const scope = new EffectScope();
  let released = false;
  scope.adopt(() => { released = true; });
  scope.add(() => { throw new Error("commit failed"); });
  await assert.rejects(scope.commit(), /commit failed/);
  assert.equal(released, true);
});

test("EffectScope bounds a non-settling disposer and continues releasing later resources", async () => {
  const scope = new EffectScope({ disposalTimeoutMs: 20 });
  let laterReleased = false;
  scope.adopt(() => { laterReleased = true; }, "later resource");
  scope.adopt(async () => { await new Promise(() => {}); }, "hung resource");

  await assert.rejects(scope.dispose(), /hung resource.*20ms/);
  assert.equal(laterReleased, true);
});

test("concurrent EffectScope disposal callers await the same actual join", async () => {
  const scope = new EffectScope();
  let release!: () => void;
  const joined = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  scope.adopt(async () => { await joined; finished = true; });
  const first = scope.dispose();
  const second = scope.dispose();
  assert.equal(first, second);
  assert.equal(finished, false);
  release();
  await second;
  assert.equal(finished, true);
});

test("timed-out startup retains its lease and disposes a resource returned late", async () => {
  const scope = new EffectScope({ operationTimeoutMs: 20 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let disposed = false;
  scope.add(async () => { await gate; return () => { disposed = true; }; });
  await assert.rejects(scope.commit(), /startup.*timed out/);
  assert.equal(scope.retirementConfirmed(), false);
  release();
  for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
  assert.equal(scope.retirementConfirmed(), true);
});

test("a late adopted resource is cleaned and remains fenced until its disposer completes", async () => {
  const scope = new EffectScope();
  await scope.dispose();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let cleaned = false;
  assert.throws(() => scope.adopt(async () => { await gate; cleaned = true; }), /already closed/);
  assert.equal(scope.retirementConfirmed(), false);
  release();
  for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cleaned, true);
  assert.equal(scope.retirementConfirmed(), true);
});

test("explicit owner failure interrupts a pending lifecycle wait without claiming its completion", async () => {
  const scope = new EffectScope({ operationTimeoutMs: 5_000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = scope.run("fixture work", async () => { await gate; });
  scope.abort(new Error("owner failed"));
  await assert.rejects(work, /owner failed/);
  await scope.dispose();
  assert.equal(scope.retirementConfirmed(), true);
  release();
});

test("application retirement join waits for a timed-out disposer without changing ordinary disposal", async () => {
  const scope = new EffectScope({ disposalTimeoutMs: 15 });
  let release!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  scope.adopt(async () => { await gate; closed = true; });
  await assert.rejects(scope.dispose(), /disposal timed out/);
  assert.equal(scope.retirementConfirmed(), false);
  let joined = false;
  const join = scope.waitForRetirement({ timeoutMs: 200 }).then(() => { joined = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(joined, false); assert.equal(closed, false);
  release(); await join;
  assert.equal(closed, true); assert.equal(scope.retirementConfirmed(), true);
  await assert.rejects(scope.dispose(), /disposal timed out/, "ordinary disposal retains its original bounded result");
});

test("application retirement join follows resources adopted by a late owned operation", async () => {
  const scope = new EffectScope({ operationTimeoutMs: 15, disposalTimeoutMs: 15 });
  let releaseOperation!: () => void, entered!: () => void, releaseResource!: () => void;
  const operationGate = new Promise<void>(resolve => { releaseOperation = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resourceGate = new Promise<void>(resolve => { releaseResource = resolve; });
  let closed = false;
  const operation = scope.run("late adoption", async () => {
    entered(); await operationGate;
    assert.throws(() => scope.adopt(async () => { await resourceGate; closed = true; }), /already closed/);
  });
  await started;
  await assert.rejects(operation, /timed out/);
  await assert.rejects(scope.dispose(), /lifecycle operations are still running/);
  let joined = false;
  const join = scope.waitForRetirement({ timeoutMs: 200 }).then(() => { joined = true; });
  releaseOperation();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(joined, false); assert.equal(scope.retirementConfirmed(), false);
  releaseResource(); await join;
  assert.equal(closed, true); assert.equal(scope.retirementConfirmed(), true);
});

test("application retirement join rejects late failure, permanent unknown rollback and never-settling owners", async () => {
  const failed = new EffectScope({ disposalTimeoutMs: 10 });
  let reject!: (error: unknown) => void;
  const rejection = new Promise<void>((_resolve, fail) => { reject = fail; });
  failed.adopt(() => rejection);
  await assert.rejects(failed.dispose(), /disposal timed out/);
  const joinFailure = failed.waitForRetirement({ timeoutMs: 100 });
  reject(new Error("late real cleanup failure"));
  await assert.rejects(joinFailure, /retirement is unconfirmed/);
  assert.equal(failed.retirementConfirmed(), false);
  const unknown = new EffectScope(); unknown.markRetirementUnconfirmed(new Error("unknown native pointer"));
  await assert.rejects(unknown.dispose(), /retirement is unconfirmed/);
  await assert.rejects(unknown.waitForRetirement({ timeoutMs: 100 }), /retirement is unconfirmed/);
  const hanging = new EffectScope({ disposalTimeoutMs: 10 });
  let release!: () => void;
  hanging.adopt(() => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(hanging.dispose(), /disposal timed out/);
  await assert.rejects(hanging.waitForRetirement({ timeoutMs: 20 }), /confirmation timed out/);
  assert.equal(hanging.retirementConfirmed(), false);
  release(); await hanging.waitForRetirement({ timeoutMs: 100 });
  assert.equal(hanging.retirementConfirmed(), true);
});


test("trusted slow effect startup and cleanup complete their finally without VM preemption", async () => {
  const scope = new EffectScope({ operationTimeoutMs: 2000, disposalTimeoutMs: 2000 });
  let started = 0, released = 0, locked = false;
  const transaction = (commit: () => void) => {
    locked = true;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); commit(); }
    finally { locked = false; }
  };
  scope.add(() => { transaction(() => started++); return () => transaction(() => released++); });
  await scope.commit(); assert.equal(started, 1); assert.equal(locked, false);
  await scope.dispose(); assert.equal(released, 1); assert.equal(locked, false);
  assert.equal(scope.retirementConfirmed(), true);
});
