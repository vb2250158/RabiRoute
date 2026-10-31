import assert from "node:assert/strict";
import test from "node:test";
import { ManagerRuntimeOwner } from "../manager/managerRuntimeOwner.js";
import { GenerationRuntime } from "./generationRuntime.js";
import type { PluginCandidate, PluginModule } from "./types.js";

function fixture() {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const runtime = new GenerationRuntime({ host: "manager", activationTimeoutMs: 100,
    executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const candidate = (module: PluginModule, revision = "one"): PluginCandidate => {
    const item: PluginCandidate = { instanceId: "owner", revision, config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: "io.test.shutdown", version: "1.0.0", provides: [], requires: [], optional: [], permissions: [],
        entries: { manager: { execution: "in_process", module: "./fixture.mjs" } } },
      policy: { resources: { shutdownTimeoutMs: 15, maxChildProcesses: 2 },
        restart: { mode: "never", maxAttempts: 0, windowMs: 1000, initialBackoffMs: 0, maximumBackoffMs: 0 } } };
    modules.set(item, module); return item;
  };
  return { runtime, candidate };
}

test("application shutdown joins the actual late owner and preserves the ordinary timeout diagnostic", async () => {
  const { runtime, candidate } = fixture();
  let release!: () => void, closed = false, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(async () => { await gate; closed = true; }); } })]);
  const shutdown = runtime.shutdown({ timeoutMs: 300 }).then(() => { finished = true; });
  await assert.rejects(runtime.dispose(), /Plugin cleanup failed/);
  assert.equal(closed, false); assert.equal(finished, false);
  assert.match(runtime.current().cleanupDiagnostics[0]!.message, /disposal timed out/);
  assert.equal(runtime.current().cleanupDiagnostics[0]!.lateConfirmed, undefined);
  release(); await shutdown;
  assert.equal(closed, true); assert.equal(finished, true);
  assert.match(runtime.current().cleanupDiagnostics[0]!.message, /disposal timed out/);
  assert.equal(runtime.current().cleanupDiagnostics[0]!.lateConfirmed, true);
  await assert.rejects(runtime.dispose(), /Plugin cleanup failed/);
});

test("ordinary switch releases its queue after a timeout and retains the old owner fence without application grace", async () => {
  const { runtime, candidate } = fixture();
  let release!: () => void, nextEntered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(() => gate); } })]);
  await runtime.switch([candidate({ activate() {} }, "two")]);
  assert.match(runtime.current().cleanupDiagnostics[0]!.message, /disposal timed out/);
  assert.equal(await runtime.publishSourcePatch(runtime.current().id, async () => "source publication remains available"), "source publication remains available");
  await runtime.switch([candidate({ activate() { nextEntered = true; } }, "three")]);
  assert.equal(nextEntered, false);
  assert.match(runtime.current().records[0]!.error!.message, /retirement is unconfirmed/);
  release(); await runtime.shutdown({ timeoutMs: 300 });
});

test("application shutdown rejects a real late disposer failure", async () => {
  const { runtime, candidate } = fixture();
  let reject!: (error: unknown) => void;
  const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(() => gate); } })]);
  const shutdown = runtime.shutdown({ timeoutMs: 300 });
  const failed = assert.rejects(shutdown, /shutdown retirement remains unconfirmed/);
  await assert.rejects(runtime.dispose(), /Plugin cleanup failed/);
  reject(new Error("native owner cleanup really failed")); await failed;
  assert.equal(runtime.current().cleanupDiagnostics[0]!.lateConfirmed, undefined);
});

test("application shutdown cannot certify an unknown rollback even after its cleanup returns", async () => {
  const { runtime, candidate } = fixture();
  await assert.rejects(runtime.switch([candidate({ activate(context) { context.publication.add({
    publish() { throw new Error("publication failed"); }, rollback() { throw undefined; }
  }); } })]));
  await assert.rejects(runtime.shutdown({ timeoutMs: 100 }), /shutdown retirement remains unconfirmed/);
  assert.ok(runtime.current().cleanupDiagnostics.every(item => item.lateConfirmed === undefined));
});

test("application shutdown has one total budget for an owner that never settles", async () => {
  const { runtime, candidate } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(() => gate); } })]);
  const shutdown = runtime.shutdown({ timeoutMs: 40 });
  await assert.rejects(shutdown, /confirmation timed out/);
  assert.equal(runtime.shutdown({ timeoutMs: 300 }), shutdown, "a failed application shutdown cannot be silently retried into success");
  release();
});

test("application shutdown joins a resource acquired by a timed-out activation", async () => {
  const { runtime, candidate } = fixture();
  let releaseOperation!: () => void, releaseResource!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { releaseOperation = resolve; });
  const resource = new Promise<void>(resolve => { releaseResource = resolve; });
  await runtime.switch([candidate({ async activate(context) {
    await gate;
    assert.throws(() => context.effects.adopt(async () => { await resource; closed = true; }), /already closed/);
  } })]);
  let finished = false;
  const shutdown = runtime.shutdown({ timeoutMs: 300 }).then(() => { finished = true; });
  releaseOperation();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(closed, false);
  releaseResource(); await shutdown;
  assert.equal(closed, true);
});

test("the actual application owner passes its remaining budget and succeeds only after kernel resources close", async () => {
  const { runtime, candidate } = fixture();
  let release!: () => void, closed = false, exitedSuccessfully = false, fenced = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(async () => { await gate; closed = true; }); } })]);
  const owner = new ManagerRuntimeOwner({ fenceIngress() { fenced = true; }, publish() {}, unpublish() {},
    resourceStopTimeoutMs: 200, teardownTimeoutMs: 300 });
  owner.registerWithBudget("plugin_kernel", budget => {
    assert.equal(Object.isFrozen(budget), true); assert.ok(budget.timeoutMs <= 200);
    return runtime.shutdown({ timeoutMs: Math.max(1, Math.floor(budget.deadlineAt - performance.now())) });
  });
  owner.publish({});
  const teardown = owner.teardown("application shutdown").then(() => { exitedSuccessfully = true; });
  assert.equal(fenced, true);
  await assert.rejects(runtime.dispose(), /Plugin cleanup failed/);
  assert.equal(closed, false); assert.equal(exitedSuccessfully, false);
  release(); await teardown;
  assert.equal(closed, true); assert.equal(exitedSuccessfully, true);
  assert.equal(runtime.current().cleanupDiagnostics[0]!.lateConfirmed, true);
});

test("the actual application owner cannot exit successfully after a real late cleanup failure", async () => {
  const { runtime, candidate } = fixture();
  let reject!: (error: unknown) => void, exitedSuccessfully = false;
  const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(() => gate); } })]);
  const owner = new ManagerRuntimeOwner({ fenceIngress() {}, publish() {}, unpublish() {},
    resourceStopTimeoutMs: 200, teardownTimeoutMs: 300 });
  owner.registerWithBudget("plugin_kernel", budget => runtime.shutdown({ timeoutMs: Math.max(1, Math.floor(budget.deadlineAt - performance.now())) }));
  const teardown = owner.teardown("application shutdown").then(() => { exitedSuccessfully = true; });
  const failure = assert.rejects(teardown, /teardown was not fully confirmed/);
  await assert.rejects(runtime.dispose(), /Plugin cleanup failed/);
  reject(new Error("actual native cleanup failed")); await failure;
  assert.equal(exitedSuccessfully, false);
});

test("the actual application owner retains its outer budget for a permanently pending kernel owner", async () => {
  const { runtime, candidate } = fixture();
  let release!: () => void, exitedSuccessfully = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await runtime.switch([candidate({ activate(context) { context.effects.adopt(() => gate); } })]);
  const owner = new ManagerRuntimeOwner({ fenceIngress() {}, publish() {}, unpublish() {},
    resourceStopTimeoutMs: 40, teardownTimeoutMs: 100 });
  owner.registerWithBudget("plugin_kernel", budget => {
    assert.ok(budget.timeoutMs <= 40);
    return runtime.shutdown({ timeoutMs: Math.max(1, Math.floor(budget.deadlineAt - performance.now())) });
  });
  await assert.rejects(owner.teardown("application shutdown").then(() => { exitedSuccessfully = true; }), /teardown was not fully confirmed/);
  assert.equal(exitedSuccessfully, false);
  assert.equal(runtime.current().cleanupDiagnostics[0]!.lateConfirmed, undefined);
  release();
});
