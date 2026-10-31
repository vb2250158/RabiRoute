import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedDeadlineProbe } from "../testFiniteDeadline.js";
import { ManagerRuntimeOwner } from "./managerRuntimeOwner.js";

for (const mode of ["legacy", "budgeted"] as const) {
  test(`${mode} resource rejection with undefined still fails teardown`, async () => {
    const owner = new ManagerRuntimeOwner({ fenceIngress() {}, publish() {}, unpublish() {} });
    if (mode === "legacy") owner.register("undefined-rejection", () => { throw undefined; });
    else owner.registerWithBudget("undefined-rejection", () => Promise.reject(undefined));
    await assert.rejects(owner.teardown("undefined-rejection"), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [undefined]);
      return true;
    });
  });
}

test("budget-aware teardown receives the effective parent deadline without changing legacy stop arguments", async () => {
  let legacyArguments = -1;
  let effectiveBudget = 0;
  const owner = new ManagerRuntimeOwner({
    fenceIngress() {}, publish() {}, unpublish() {},
    resourceStopTimeoutMs: 1000, teardownTimeoutMs: 200
  });
  owner.register("legacy", function () { legacyArguments = arguments.length; });
  owner.registerWithBudget("budget-aware", budget => {
    effectiveBudget = budget.timeoutMs;
    assert.ok(budget.timeoutMs > 0 && budget.timeoutMs <= 100,
      "the child must receive the existing fair-share budget, not a larger timeout");
    assert.ok(budget.deadlineAt - performance.now() <= budget.timeoutMs);
    assert.ok(Object.isFrozen(budget));
  });
  await owner.teardown("budget-contract");
  assert.equal(legacyArguments, 0);
  assert.ok(effectiveBudget > 0);
  assert.throws(() => owner.registerWithBudget("late", () => {}), /cannot acquire/);
});

test("budget-aware teardown still fails on the existing parent deadline and observes late rejection", async () => {
  let rejectStop = (_error: unknown): void => {};
  const stopping = new Promise<void>((_resolve, reject) => { rejectStop = reject; });
  const owner = new ManagerRuntimeOwner({
    fenceIngress() {}, publish() {}, unpublish() {},
    resourceStopTimeoutMs: 20, teardownTimeoutMs: 100
  });
  owner.registerWithBudget("pending", budget => {
    assert.equal(budget.timeoutMs, 20);
    return stopping;
  });
  await assert.rejects(owner.teardown("budget-expiry"), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /resource stop timed out/);
    return true;
  });
  rejectStop(new Error("late owner rejection"));
  await new Promise(resolve => setImmediate(resolve));
});

for (const outcome of ["resolved", "timeout"] as const) {
  test(`isolated teardown ${outcome} settles without a ref keeper and exits`, () => {
    runIsolatedDeadlineProbe(`
      import assert from "node:assert/strict";
      import { ManagerRuntimeOwner } from "./src/manager/managerRuntimeOwner.ts";
      const owner = new ManagerRuntimeOwner({
        fenceIngress() {}, publish() {}, unpublish() {}, resourceStopTimeoutMs: 20
      });
      owner.register("fixture", () => ${outcome === "timeout" ? "new Promise(() => {})" : "Promise.resolve()"});
      const stopping = owner.teardown("isolated-probe");
      assert.equal(owner.teardown("duplicate"), stopping);
      ${outcome === "timeout" ? `await assert.rejects(stopping, error => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(error.errors[0].message, /resource stop timed out/);
        return true;
      });` : "await stopping;"}
      console.log("deadline-probe-complete");
    `);
  });
}

test("publish is unique and teardown fences synchronously before reverse awaited release", async () => {
  const events: string[] = [];
  let releaseFirst = (): void => {};
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const owner = new ManagerRuntimeOwner<{ generation: string }>({
    fenceIngress: reason => { events.push(`fence:${reason}`); },
    publish: publication => { events.push(`publish:${publication.generation}`); },
    unpublish: publication => { events.push(`unpublish:${publication.generation}`); }
  });

  owner.register("first", async () => {
    events.push("stop:first");
    await firstReleased;
  });
  owner.register("second", async () => { events.push("stop:second"); });
  owner.publish({ generation: "g1" });

  const teardown = owner.teardown("test");
  assert.deepEqual(events, ["publish:g1", "fence:test", "unpublish:g1"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["publish:g1", "fence:test", "unpublish:g1", "stop:second", "stop:first"]);
  releaseFirst();
  await teardown;
  assert.equal(owner.isTearingDown(), true);
});

test("constructor, plugin, request and signal callers share one teardown flight", async () => {
  let stops = 0;
  const owner = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {}
  });
  owner.register("cordis", async () => { stops += 1; });

  const constructorFlight = owner.teardown("constructor");
  const pluginFlight = owner.teardown("plugin");
  const requestFlight = owner.teardown("request");
  const signalFlight = owner.teardown("signal");
  assert.strictEqual(pluginFlight, constructorFlight);
  assert.strictEqual(requestFlight, constructorFlight);
  assert.strictEqual(signalFlight, constructorFlight);
  await constructorFlight;
  assert.equal(stops, 1);
});

test("late primary failure joins the active teardown flight", async () => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const primary = new Error("startup failed after signal");
  const owner = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {}
  });
  owner.register("held", () => held);

  const signalFlight = owner.teardown("signal");
  const startupFlight = owner.teardown("startup", primary);
  assert.strictEqual(startupFlight, signalFlight);
  release();

  await assert.rejects(signalFlight, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary]);
    return true;
  });
});

test("teardown aggregates primary, fence, unpublish and every resource failure", async () => {
  const reported: string[] = [];
  const owner = new ManagerRuntimeOwner<{ generation: string }>({
    fenceIngress: () => { throw new Error("fence failed"); },
    publish: () => {},
    unpublish: () => { throw new Error("unpublish failed"); },
    onResourceStopError: (resource, error) => {
      reported.push(`${resource}:${(error as Error).message}`);
    }
  });
  owner.register("root", async () => { throw new Error("root failed"); });
  owner.register("shared", async () => { throw new Error("shared failed"); });
  owner.publish({ generation: "g1" });

  await assert.rejects(
    owner.teardown("startup", new Error("startup failed")),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(item => (item as Error).message),
        ["startup failed", "fence failed", "unpublish failed", "shared failed", "root failed"]
      );
      return true;
    }
  );
  assert.deepEqual(reported, ["shared:shared failed", "root:root failed"]);
});

test("resources cannot be acquired after publish or teardown begins", async () => {
  const published = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {}
  });
  published.publish(null);
  assert.throws(() => published.register("late", async () => {}), /state=published/);
  await published.teardown("done");

  const failed = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {}
  });
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  failed.register("held", () => held);
  const stopping = failed.teardown("constructor", new Error("failed"));
  const observedStopping = assert.rejects(stopping, AggregateError);
  assert.throws(() => failed.register("late", async () => {}), /state=tearing_down/);
  release();
  await observedStopping;
});

test("a late startup failure joins an already-running signal teardown flight", async () => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {}
  });
  owner.register("held", () => held);

  const signalFlight = owner.teardown("signal:SIGTERM");
  const startupError = new Error("startup failed after signal");
  const startupFlight = owner.teardown("manager_runtime_construction", startupError);
  assert.strictEqual(startupFlight, signalFlight);
  release();

  await assert.rejects(signalFlight, (error: unknown) => error instanceof AggregateError
    && error.errors.includes(startupError));
});

test("resource deadlines and observer failures never interrupt reverse-order teardown", async () => {
  const events: string[] = [];
  const owner = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {},
    resourceStopTimeoutMs: 5,
    onResourceStopError(resource) {
      events.push(`observe:${resource}`);
      throw new Error(`observer failed:${resource}`);
    }
  });
  owner.register("first", async () => { events.push("stop:first"); throw new Error("first failed"); });
  owner.register("hung", () => { events.push("stop:hung"); return new Promise(() => {}); });
  owner.register("last", async () => { events.push("stop:last"); throw new Error("last failed"); });

  await assert.rejects(owner.teardown("deadline"), (error: unknown) => {
    assert(error instanceof AggregateError);
    const messages = error.errors.map(item => (item as Error).message);
    assert.deepEqual(messages, [
      "last failed",
      "observer failed:last",
      "Manager runtime resource stop timed out: owner=hung; timeoutMs=5.",
      "observer failed:hung",
      "first failed",
      "observer failed:first"
    ]);
    return true;
  });
  assert.deepEqual(events, [
    "stop:last", "observe:last",
    "stop:hung", "observe:hung",
    "stop:first", "observe:first"
  ]);
});

test("a hung earlier stop cannot consume the total budget before later disposers are called", async () => {
  const events: string[] = [];
  const owner = new ManagerRuntimeOwner<null>({
    fenceIngress: () => {},
    publish: () => {},
    unpublish: () => {},
    resourceStopTimeoutMs: 1_000,
    teardownTimeoutMs: 18
  });
  owner.register("last", async () => { events.push("stop:last"); });
  owner.register("middle", async () => { events.push("stop:middle"); });
  owner.register("hung-first", () => {
    events.push("stop:hung-first");
    return new Promise(() => {});
  });

  await assert.rejects(owner.teardown("total-budget"), AggregateError);
  assert.deepEqual(events, ["stop:hung-first", "stop:middle", "stop:last"]);
});
