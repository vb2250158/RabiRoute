import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { GenerationRuntime } from "./generationRuntime.js";
import type { HostService, PluginCandidate, PluginContext, PluginModule } from "./types.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(onPrepare?: (candidate: PluginCandidate) => Promise<void>, hostServices: readonly HostService[] = []) {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const runtime = new GenerationRuntime({ host: "manager", hostServices, executor: { async prepare(candidate) {
    await onPrepare?.(candidate);
    return modules.get(candidate)!;
  } } });
  const plugin = (id: string, activate: (context: PluginContext) => void | Promise<void>, requires: string[] = [], revision = "one", optional: string[] = [], serviceValue?: unknown): PluginCandidate => {
    const candidate: PluginCandidate = { instanceId: id, revision, config: {},
      manifest: { schemaVersion: 2, id: `io.test.${id}`, version: "1.0.0", entries: { manager: { execution: "in_process", module: "manager.mjs" } },
        provides: [`test.${id}@1`], requires, optional, permissions: [] }, entry: { execution: "in_process", path: "virtual.mjs" } };
    modules.set(candidate, { async activate(context) {
      await activate(context);
      context.services.provide(`test.${id}@1`, serviceValue ?? { revision });
    } });
    return candidate;
  };
  return { runtime, plugin };
}

test("slow optional initialization leaves independent publication and management available", async t => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate();
  t.after(async () => { slow.resolve(); await runtime.dispose(); });
  const a = plugin("a", async () => { entered.resolve(); await slow.promise; });
  const b = plugin("b", () => {});
  const intent = await runtime.switch([a, b], { initialization: "background" });
  assert.ok(intent.generation.records.some(record => record.status === "initializing"));
  await entered.promise; await runtime.settle("b");
  assert.equal(runtime.current().services.services.has("test.b@1"), true);
  assert.equal(runtime.current().services.services.has("test.a@1"), false);
  assert.equal(await runtime.publishSourcePatch(runtime.current().id, async () => "management usable"), "management usable");
  slow.resolve(); await runtime.settle();
  assert.equal(runtime.current().records.every(record => record.status === "active"), true);
});

test("default switch still awaits actual initialization and required dependency publication", async t => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate(); let consumer = false;
  t.after(async () => { slow.resolve(); await runtime.dispose(); });
  const a = plugin("a", async () => { entered.resolve(); await slow.promise; });
  const b = plugin("b", context => { context.services.require("test.a@1"); consumer = true; }, ["test.a@1"]);
  let finished = false;
  const switching = runtime.switch([a, b], { readyRequires: ["test.b@1"] }).then(value => { finished = true; return value; });
  await entered.promise; await turn(); assert.equal(finished, false); assert.equal(consumer, false);
  slow.resolve(); const result = await switching;
  assert.equal(result.generation.readiness.state, "ready"); assert.equal(consumer, true);
});

test("removing an initializing instance aborts it and retains a late resource until its actual disposer", async t => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate(), disposed = gate(); let signal!: AbortSignal, published = 0;
  t.after(async () => { slow.resolve(); await runtime.dispose(); });
  const a = plugin("a", async context => {
    signal = context.lifecycle.signal; entered.resolve();
    context.publication.add({ publish() { published++; }, rollback() {} });
    await slow.promise;
    context.effects.adopt(() => { disposed.resolve(); }, "late resource");
  });
  await runtime.switch([a], { initialization: "background" }); await entered.promise;
  await runtime.switch([], { initialization: "background" });
  assert.equal(signal.aborted, true); assert.equal(runtime.current().services.services.has("test.a@1"), false);
  await assert.rejects(runtime.settle("a"), /retirement is unconfirmed/);
  slow.resolve(); await disposed.promise; await turn(); await runtime.settle("a");
  assert.equal(published, 0);
});

test("failed asynchronous replacement retains the original published provider", async t => {
  const { runtime, plugin } = fixture(); t.after(() => runtime.dispose());
  const original = plugin("a", () => {}); await runtime.switch([original]);
  const identity = runtime.current().records[0]!.identity;
  const bad = plugin("a", async () => { await turn(); throw new Error("replacement failed"); }, [], "two");
  await runtime.switch([bad], { initialization: "background" });
  assert.equal(runtime.current().records[0]!.status, "active");
  assert.equal(runtime.current().records[0]!.identity.activationId, identity.activationId);
  assert.equal(runtime.current().records[0]!.initialization?.state, "initializing");
  await runtime.settle();
  assert.equal(runtime.current().records[0]!.identity.activationId, identity.activationId);
  assert.equal(runtime.current().records[0]!.error?.code, "update_failed_using_previous_revision");
});

test("declared optional consumers bind the initialized provider without holding unrelated components", async t => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate(); let bound: unknown;
  t.after(async () => { slow.resolve(); await runtime.dispose(); });
  const a = plugin("a", async () => { entered.resolve(); await slow.promise; });
  const b = plugin("b", context => { bound = context.services.optional("test.a@1"); }, [], "one", ["test.a@1"]);
  const independent = plugin("independent", () => {});
  await runtime.switch([a, b, independent], { initialization: "background" }); await entered.promise;
  await runtime.settle("independent"); assert.equal(bound, undefined);
  slow.resolve(); await runtime.settle(); assert.deepEqual(bound, { revision: "one" });
  assert.equal(runtime.current().records.every(record => record.status === "active"), true);
});

test("shutdown does not confirm a cancelled initializer until its original operation returns", async () => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate();
  const a = plugin("a", async () => { entered.resolve(); await slow.promise; });
  await runtime.switch([a], { initialization: "background" }); await entered.promise;
  await assert.rejects(runtime.dispose(), error => error instanceof AggregateError
    && error.errors.length > 0 && error.errors.every(value => value instanceof Error && /lifecycle operations are still running/.test(value.message)));
  await assert.rejects(runtime.shutdown({ timeoutMs: 20 }), /timed out|unconfirmed/);
  slow.resolve(); await turn();
});

test("published asynchronous startup remains visible and removal cancels its original owner", async t => {
  const { runtime, plugin } = fixture(); const slow = gate(), entered = gate(), cleaned = gate(); let signal!: AbortSignal;
  t.after(async () => { slow.resolve(); await runtime.dispose(); });
  const a = plugin("a", context => {
    signal = context.lifecycle.signal;
    context.effects.adopt(() => cleaned.resolve());
    context.publication.add({ publish() {}, rollback() {}, async afterPublish() {
      entered.resolve(); await slow.promise; signal.throwIfAborted();
    } });
  });
  await runtime.switch([a], { initialization: "background" }); await entered.promise;
  assert.equal(runtime.current().records[0]?.status, "active");
  assert.equal(runtime.current().records[0]?.initialization?.state, "initializing");
  await runtime.switch([], { initialization: "background" }); await cleaned.promise;
  assert.equal(signal.aborted, true); assert.equal(runtime.current().records.length, 0);
  slow.resolve(); await turn(); await runtime.settle("a");
  assert.equal(runtime.current().records.length, 0);
});

test("removed services expose their original delayed disposer as stopping until physical confirmation", async t => {
  const { runtime, plugin } = fixture(); const release = gate(), entered = gate();
  t.after(async () => { release.resolve(); await runtime.dispose(); });
  const a = plugin("a", context => context.effects.adopt(async () => { entered.resolve(); await release.promise; }));
  await runtime.switch([a]); const activationId = runtime.current().records[0]!.identity.activationId;
  await runtime.switch([], { initialization: "background" }); await entered.promise;
  assert.equal(runtime.current().records.length, 0);
  assert.equal(runtime.current().services.services.has("test.a@1"), false);
  assert.deepEqual(runtime.pendingRetirements().map(row => [row.identity.activationId, row.status]), [[activationId, "stopping"]]);
  release.resolve(); await runtime.settle("a");
  assert.deepEqual(runtime.pendingRetirements(), []);
});

test("removing during original preparation exposes the unsettled scope and never enters activation late", async t => {
  const release = gate(), entered = gate(); let activations = 0;
  const { runtime, plugin } = fixture(async () => { entered.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); await runtime.dispose(); });
  const a = plugin("a", () => { activations++; });
  await runtime.switch([a], { initialization: "background" }); await entered.promise;
  const preparingIdentity = runtime.current().records[0]!.identity;
  await runtime.switch([], { initialization: "background" });
  const pending = runtime.pendingRetirements();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.identity.activationId, preparingIdentity.activationId);
  assert.ok(["stopping", "retirement_unconfirmed"].includes(pending[0]!.status));
  assert.equal(runtime.current().services.services.has("test.a@1"), false);
  release.resolve(); await turn(); await runtime.settle("a");
  assert.equal(activations, 0); assert.deepEqual(runtime.pendingRetirements(), []);
});

for (const kind of ["required", "optional"] as const) {
  test(`stable ${kind} Host service keeps one asynchronous activation across an unrelated switch`, { timeout: 2000 }, async t => {
    const host = Object.freeze({ connected: true }); const release = gate(), entered = gate(); let activations = 0;
    const { runtime, plugin } = fixture(undefined, [{ capability: "host.fixture@1", value: host }]);
    t.after(async () => { release.resolve(); await runtime.dispose(); });
    const a = plugin("a", async context => {
      activations++;
      assert.equal(kind === "required" ? context.services.require("host.fixture@1") : context.services.optional("host.fixture@1"), host);
      entered.resolve(); await release.promise;
    }, kind === "required" ? ["host.fixture@1"] : [], "one", kind === "optional" ? ["host.fixture@1"] : []);
    await runtime.switch([a], { initialization: "background" }); await entered.promise;
    const b = plugin("b", () => {});
    await runtime.switch([a, b], { initialization: "background" }); await runtime.settle("b");
    assert.equal(activations, 1);
    release.resolve(); await runtime.settle();
    assert.equal(activations, 1);
    assert.equal(runtime.current().records.every(record => record.status === "active"), true);
    const id = runtime.current().records.find(record => record.identity.instanceId === "a")!.identity.activationId;
    await runtime.switch([a, b]);
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === "a")!.identity.activationId, id);
    assert.equal(activations, 1);
  });
}

test("a real plugin provider replacement still rebuilds its consumer even when service value is identical", async t => {
  const { runtime, plugin } = fixture(); t.after(() => runtime.dispose());
  const value = Object.freeze({ shared: "same value" }); let providerStarts = 0, consumerStarts = 0;
  const provider = (revision: string) => plugin("provider", () => { providerStarts++; }, [], revision, [], value);
  const consumer = plugin("consumer", context => {
    consumerStarts++; assert.equal(context.services.require("test.provider@1"), value);
  }, ["test.provider@1"]);
  await runtime.switch([provider("one"), consumer]);
  const prior = runtime.current().records.find(record => record.identity.instanceId === "consumer")!.identity.activationId;
  await runtime.switch([provider("two"), consumer]);
  assert.equal(providerStarts, 2); assert.equal(consumerStarts, 2);
  assert.notEqual(runtime.current().records.find(record => record.identity.instanceId === "consumer")!.identity.activationId, prior);
});

for (const updating of [false, true]) {
  test(`late contribution collision isolates only the conflicting group and preserves published fallback: ${updating}`, async t => {
    const { runtime, plugin } = fixture(); const release = gate();
    t.after(async () => { release.resolve(); await runtime.dispose(); });
    let previous: string | undefined;
    if (updating) {
      const old = plugin("second", context => context.contributions.register({ kind: "fixture", id: "old", value: "original" }));
      await runtime.switch([old]); previous = runtime.current().records[0]!.identity.activationId;
    }
    const withCollision = (id: string) => plugin(id, async context => {
      await release.promise;
      context.contributions.register({ kind: "fixture", id: "collision", value: id });
    }, [], updating && id === "second" ? "two" : "one");
    const first = withCollision("first"), second = withCollision("second"), independent = plugin("independent", () => {});
    await runtime.switch([first, second, independent], { initialization: "background" });
    release.resolve(); await runtime.settle();
    const records = new Map(runtime.current().records.map(record => [record.identity.instanceId, record]));
    assert.equal(records.get("first")?.status, "active");
    assert.equal(records.get("independent")?.status, "active");
    assert.equal(records.get("second")?.status, updating ? "active" : "failed");
    assert.equal(records.get("second")?.error?.code, updating ? "update_failed_using_previous_revision" : "activation_failed");
    if (updating) assert.equal(records.get("second")?.identity.activationId, previous);
    assert.equal(runtime.current().contributions.contributions.filter(row => row.id === "collision").length, 1);
    assert.equal(runtime.current().records.some(record => record.status === "initializing"), false);
  });
}

test("dispose also cancels initialization created by an earlier queued switch in the same turn", async () => {
  const release = gate(); let activations = 0;
  const { runtime, plugin } = fixture(async () => { await release.promise; });
  const a = plugin("a", () => { activations++; });
  const switching = runtime.switch([a], { initialization: "background" });
  const disposing = runtime.dispose();
  await turn(); release.resolve();
  await Promise.allSettled([switching, disposing]);
  assert.equal(activations, 0);
  assert.equal(runtime.current().services.services.has("test.a@1"), false);
  assert.deepEqual(runtime.pendingRetirements(), []);
});
