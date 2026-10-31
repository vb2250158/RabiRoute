import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import {
  GenerationRuntime,
  RequiredPluginCapabilitiesUnavailableError,
  selectReadyPluginCandidates
} from "./generationRuntime.js";
import type { PluginCandidate, PluginManifest, PluginModule } from "./types.js";

const testModules = new WeakMap<PluginCandidate, PluginModule>();
const testExecutor = Object.freeze({
  async prepare(item: PluginCandidate): Promise<PluginModule> {
    const module = testModules.get(item);
    if (!module) throw new Error(`Missing test module: ${item.instanceId}.`);
    return module;
  }
});

function manifest(id: string, input: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 2, id, version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: [], ...input
  };
}
function candidate(input: Partial<PluginCandidate> & Pick<PluginCandidate, "instanceId" | "manifest"> & { module: PluginModule }): PluginCandidate {
  const { module, ...candidateInput } = input;
  const result: PluginCandidate = {
    revision: "one", config: {}, entry: { execution: "in_process", path: "virtual.mjs" }, ...candidateInput
  };
  testModules.set(result, module);
  return result;
}
function createRuntime(options: Omit<ConstructorParameters<typeof GenerationRuntime>[0], "host" | "executor"> = {}): GenerationRuntime {
  return new GenerationRuntime({ host: "manager", executor: testExecutor, ...options });
}

test("trusted slow publication and rollback finish their transactions and release the generation queue", { timeout: 5000 }, async () => {
  const runtime = createRuntime();
  let visible = "old", finalized = 0;
  const slow = (operation: () => void) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); operation(); }
    finally { finalized++; }
  };
  const initial = candidate({ instanceId: "owner", manifest: manifest("io.test.owner"), module: { activate() {} } });
  await runtime.switch([initial]);
  try {
    const next = candidate({ instanceId: "owner", revision: "next", manifest: manifest("io.test.owner"), module: {
      activate(context) { context.publication.add({ publish: () => slow(() => { visible = "new"; }), rollback: () => slow(() => { visible = "old"; }) }); }
    } });
    await runtime.switch([next], { beforePublish: () => slow(() => {}) });
    assert.equal(visible, "new"); assert.equal(finalized, 2);
    const original = runtime.current().id;
    const bad = candidate({ instanceId: "owner", revision: "bad", manifest: manifest("io.test.owner"), module: {
      activate(context) { context.publication.add({ publish() { visible = "bad"; throw new Error("fixture publication failed"); }, rollback: () => slow(() => { visible = "new"; }) }); }
    } });
    await assert.rejects(runtime.switch([bad]), /fixture publication failed/);
    assert.equal(visible, "new"); assert.equal(finalized, 3); assert.equal(runtime.current().id, original);
    assert.equal(await runtime.publishSourcePatch(original, async () => "owner remains usable"), "owner remains usable");
  } finally { await runtime.dispose(); }
});

test("unconfirmed publication rollback revokes the affected old Web group and dependents before cleanup", async () => {
  for (const blockRollback of [false, true]) {
    const runtime = createRuntime();
    let pointer = "old";
    const shared = manifest("io.test.shared", { entries: {
      manager: { execution: "in_process", module: "./manager.mjs" },
      web: { execution: "in_process", module: "./web.mjs" }
    }, provides: ["test.shared@1"] });
    const sharedSibling = { ...shared, provides: [] };
    const owner = candidate({ instanceId: "owner", manifest: shared, module: { activate(ctx) {
      ctx.services.provide("test.shared@1", { read: () => pointer });
    } } });
    const sibling = candidate({ instanceId: "sibling", manifest: sharedSibling, module: { activate() {} } });
    const consumer = candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", {
      optional: ["test.shared@1"], provides: ["test.consumer@1"]
    }), module: { activate(ctx) { ctx.services.provide("test.consumer@1", {}); } } });
    const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy", { provides: ["test.healthy@1"] }),
      module: { activate(ctx) { ctx.services.provide("test.healthy@1", { ready: true }); } } });
    try {
      await runtime.switch([owner, sibling, consumer, healthy]);
      const healthyActivation = runtime.current().records.find(item => item.identity.instanceId === "healthy")!.identity.activationId;
      const update = candidate({ instanceId: "owner", revision: "two", manifest: shared, module: { activate(ctx) {
        ctx.services.provide("test.shared@1", { read: () => pointer });
        ctx.publication.add({ publish() { pointer = "bad"; throw new Error("publication failed"); }, rollback() {
          if (blockRollback) {
            const end = performance.now() + 250;
            while (performance.now() < end) { /* rollback never reaches pointer restoration */ }
          }
          throw undefined;
        } });
      } } });
      const siblingUpdate = candidate({ instanceId: "sibling", revision: "two", manifest: sharedSibling, module: { activate() {} } });
      await assert.rejects(runtime.switch([update, siblingUpdate, consumer, healthy]), /rollback or cleanup also failed/);
      const current = runtime.current();
      assert.equal(pointer, "bad");
      assert.equal(current.readiness.state, "degraded");
      assert.equal(current.services.services.has("test.shared@1"), false);
      assert.equal(current.services.services.has("test.consumer@1"), false);
      assert.equal(current.records.find(item => item.identity.instanceId === "owner")?.error?.code, "publication_rollback_unconfirmed");
      assert.equal(current.records.find(item => item.identity.instanceId === "sibling")?.status, "failed");
      assert.equal(current.records.find(item => item.identity.instanceId === "consumer")?.status, "failed");
      assert.equal(current.records.find(item => item.identity.instanceId === "consumer")?.error?.code, "publication_rollback_unconfirmed");
      assert.equal(current.records.find(item => item.identity.instanceId === "healthy")?.identity.activationId, healthyActivation);
      assert.equal(current.services.services.has("test.healthy@1"), true);
      assert.equal(await runtime.publishSourcePatch(current.id, async () => "healthy queue"), "healthy queue");
    } finally { await assert.rejects(runtime.dispose(), /Plugin cleanup failed/); }
  }
});

test("source publication shares the generation mutation fence without blocking snapshot reads", async () => {
  const runtime = createRuntime();
  const original = runtime.current().id;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const publication = runtime.publishSourcePatch(original, async () => { entered(); await gate; return "published"; });
    await started;
    const switching = runtime.switch([candidate({ instanceId: "next", manifest: manifest("io.test.next"), module: { activate() {} } })]);
    assert.equal(runtime.current().id, original);
    release();
    assert.equal(await publication, "published");
    await switching;
    await assert.rejects(runtime.publishSourcePatch(original, async () => "unexpected"), /no longer active/);
  } finally { release(); await runtime.dispose(); }
});

test("GenerationRuntime keeps candidate routes invisible until publication and hides failed candidates", async () => {
  const runtime = createRuntime();
  const routes = new ManagerPluginRouteRegistry(() => new Set(runtime.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId)));
  let observed = "";
  const read = () => {
    observed = "";
    routes.handle({ method: "GET" } as IncomingMessage, new URL("http://localhost/test"), {} as ServerResponse);
    return observed;
  };
  const revision = (label: string, barrier: () => Promise<void> = async () => {}) => candidate({
    instanceId: "routes", revision: label, manifest: manifest("io.test.routes"),
    module: { activate(context) {
      context.effects.add(async () => {
        const unregister = routes.register("routes", [{ routeId: "test", match: { kind: "exact", path: "/test" },
          handler: () => { observed = label; return true; } }]);
        try { await barrier(); } catch (error) { unregister(); throw error; }
        return unregister;
      });
    } }
  });
  try {
    assert.throws(() => routes.register("outside", []), /activation context/);
    await runtime.switch([revision("old")]);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const switching = runtime.switch([revision("new", async () => { entered(); await waiting; })]);
    await started;
    assert.equal(read(), "old");
    release();
    await switching;
    assert.equal(read(), "new");
    await runtime.switch([revision("failed", async () => {
      assert.equal(read(), "new");
      throw new Error("candidate failed");
    })]);
    assert.equal(read(), "new");
  } finally { await runtime.dispose(); }
  assert.equal(read(), "");
});

test("GenerationRuntime publishes services and contributions atomically", async () => {
  const lifecycle: string[] = [];
  const runtime = createRuntime();
  const result = await runtime.switch([
    candidate({
      instanceId: "provider", manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
      module: { activate(ctx) {
        ctx.services.provide("test.value@1", 42);
        ctx.contributions.register({ kind: "page", id: "test", value: { path: "/test" } });
        ctx.effects.add(() => { lifecycle.push("start-provider"); return () => { lifecycle.push("stop-provider"); }; });
      } }
    }),
    candidate({
      instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"] }),
      module: { activate(ctx) {
        assert.equal(ctx.services.require("test.value@1"), 42);
        ctx.effects.add(() => { lifecycle.push("start-consumer"); return () => { lifecycle.push("stop-consumer"); }; });
      } }
    })
  ]);
  assert.deepEqual(lifecycle, ["start-provider", "start-consumer"]);
  assert.equal(result.generation.services.services.get("test.value@1")?.value, 42);
  assert.equal(result.generation.contributions.contributions[0]?.id, "test");
  await runtime.dispose();
  assert.deepEqual(lifecycle, ["start-provider", "start-consumer", "stop-consumer", "stop-provider"]);
});

test("GenerationRuntime isolates a failed plugin from independent active plugins", async () => {
  const runtime = createRuntime();
  const stable = candidate({ instanceId: "stable", manifest: manifest("io.test.stable"), module: { activate() {} } });
  await runtime.switch([stable]);
  const result = await runtime.switch([
    stable,
    candidate({ instanceId: "broken", manifest: manifest("io.test.broken"), module: { activate() { throw new Error("broken"); } } })
  ]);
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "stable")?.status, "active");
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "broken")?.status, "failed");
  assert.match(result.generation.records.find(record => record.identity.instanceId === "broken")?.error?.message ?? "", /broken/);
});

test("installed plugin uses declared host APIs without a second Profile grant", async () => {
  const runtime = createRuntime({ grantedPermissions: () => [] });
  let used = false;
  const result = await runtime.switch([
    candidate({
      instanceId: "desktop", manifest: manifest("io.test.desktop", { permissions: ["desktop.ipc.codex"] }),
      module: { activate(context) {
        context.permissions.require("desktop.ipc.codex");
        assert.throws(() => context.permissions.require("undeclared.host.api"), /required/);
        used = true;
      } }
    })
  ]);
  assert.equal(result.generation.records[0]?.status, "active");
  assert.equal(used, true);
});

test("GenerationRuntime keeps the previous component when effect publication fails", async () => {
  const runtime = createRuntime();
  let stableStarts = 0;
  let stableStops = 0;
  await runtime.switch([
    candidate({
      instanceId: "stable",
      manifest: manifest("io.test.stable"),
      module: { activate(ctx) {
        ctx.effects.add(() => { stableStarts += 1; return () => { stableStops += 1; }; });
      } }
    })
  ]);
  const result = await runtime.switch([
    candidate({
      instanceId: "stable",
      revision: "two",
      manifest: manifest("io.test.stable"),
      module: { activate(ctx) { ctx.effects.add(() => { throw new Error("publish failed"); }); } }
    })
  ]);
  const record = result.generation.records[0];
  assert.equal(record?.status, "active");
  assert.equal(record?.identity.revision, "one");
  assert.equal(record?.error?.code, "update_failed_using_previous_revision");
  assert.match(record?.error?.message ?? "", /publish failed/);
  assert.equal(stableStarts, 1);
  assert.equal(stableStops, 0);
  await runtime.dispose();
  assert.equal(stableStops, 1);
});

test("GenerationRuntime skips unchanged plugins and restarts only the dependency component", async () => {
  const lifecycle: string[] = [];
  const runtime = createRuntime({
    applicationIdentity: { applicationGenerationId: "app-one", managerInstanceId: "manager-one" }
  });
  const createProvider = (revision: string) => candidate({
    instanceId: "provider", revision, manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
    module: { activate(ctx) {
      ctx.services.provide("test.value@1", revision);
      ctx.effects.add(() => { lifecycle.push(`start-provider-${revision}`); return () => { lifecycle.push(`stop-provider-${revision}`); }; });
    } }
  });
  const consumer = candidate({
    instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"] }),
    module: { activate(ctx) {
      const value = ctx.services.require<string>("test.value@1");
      ctx.effects.add(() => { lifecycle.push(`start-consumer-${value}`); return () => { lifecycle.push(`stop-consumer-${value}`); }; });
    } }
  });
  const independent = candidate({
    instanceId: "independent", manifest: manifest("io.test.independent"),
    module: { activate(ctx) { ctx.effects.add(() => { lifecycle.push("start-independent"); return () => { lifecycle.push("stop-independent"); }; }); } }
  });

  await runtime.switch([createProvider("one"), consumer, independent]);
  const unchanged = await runtime.switch([createProvider("one"), consumer, independent]);
  assert.equal(unchanged.changed, false);
  await runtime.switch([createProvider("two"), consumer, independent]);
  assert.deepEqual(lifecycle, [
    "start-independent", "start-provider-one", "start-consumer-one",
    "start-provider-two", "start-consumer-two",
    "stop-consumer-one", "stop-provider-one"
  ]);
  await runtime.dispose();
  assert.equal(lifecycle.filter(item => item === "start-independent").length, 1);
  assert.equal(lifecycle.filter(item => item === "stop-independent").length, 1);
});

test("GenerationRuntime keeps activation identity and rejects a hot switch that loses required capabilities", async () => {
  const runtime = createRuntime({
    applicationIdentity: { applicationGenerationId: "app-one", managerInstanceId: "manager-one" }
  });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const first = await runtime.switch([core], { readyRequires: ["manager.core@1"] });
  const coreActivation = first.generation.records[0]!.identity.activationId;
  assert.equal(first.generation.readiness.state, "ready");
  assert.equal(first.generation.applicationGenerationId, "app-one");
  const optional = candidate({ instanceId: "optional", manifest: manifest("io.test.optional"), module: { activate() {} } });
  const second = await runtime.switch([core, optional], { readyRequires: ["manager.core@1"] });
  assert.equal(second.generation.records.find(record => record.identity.instanceId === "core")?.identity.activationId, coreActivation);
  await assert.rejects(
    runtime.switch([optional], { readyRequires: ["manager.core@1"] }),
    (error: unknown) => error instanceof Error
      && error.name === "RequiredPluginCapabilitiesUnavailableError"
      && /manager\.core@1/.test(error.message)
  );
  assert.equal(runtime.current().id, second.generation.id);
  assert.equal(runtime.current().services.services.get("manager.core@1")?.value !== undefined, true);
  await runtime.dispose();
});

test("required readiness failure preserves bounded plugin activation diagnostics", async () => {
  const runtime = createRuntime();
  const brokenCore = candidate({
    instanceId: "broken-core",
    manifest: manifest("io.test.broken-core", { provides: ["manager.core@1"] }),
    module: { activate() { throw new Error("fixture activation failed"); } }
  });
  await assert.rejects(
    runtime.switch([brokenCore], { readyRequires: ["manager.core@1"] }),
    (error: unknown) => error instanceof RequiredPluginCapabilitiesUnavailableError
      && error.diagnostics.length === 1
      && error.diagnostics[0]?.identity.instanceId === "broken-core"
      && error.diagnostics[0]?.error?.message === "fixture activation failed"
      && error.message.includes("broken-core: fixture activation failed")
  );
  await runtime.dispose();
});

test("falsy update failures retain the confirmed revision and report degraded readiness", async () => {
  for (const failure of [undefined, null, false, 0, ""]) {
    const runtime = createRuntime();
    const old = candidate({ instanceId: "owner", manifest: manifest("io.test.owner"), module: { activate() {} } });
    try {
      await runtime.switch([old]);
      const update = candidate({ instanceId: "owner", revision: "two", manifest: old.manifest,
        module: { activate() { throw failure; } } });
      const result = await runtime.switch([update]);
      const record = result.generation.records.find(item => item.identity.instanceId === "owner");
      assert.equal(record?.identity.revision, "one");
      assert.equal(record?.error?.code, "update_failed_using_previous_revision");
      assert.equal(record?.error?.message, String(failure));
      assert.equal(result.generation.readiness.state, "degraded");
    } finally { await runtime.dispose(); }
  }
});

test("an optional activation failure reports degraded health without removing core readiness", async () => {
  const runtime = createRuntime();
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const brokenOptional = candidate({
    instanceId: "optional",
    manifest: manifest("io.test.optional"),
    module: { activate() { throw new Error("optional dependency unavailable"); } }
  });

  const result = await runtime.switch([core, brokenOptional], { readyRequires: ["manager.core@1"] });
  assert.equal(result.generation.readiness.state, "degraded");
  assert.deepEqual(result.generation.readiness.missingCapabilities, []);
  assert.ok(result.generation.services.services.has("manager.core@1"));
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "optional")?.status, "failed");
  await runtime.dispose();
});

test("ready candidate selection excludes unrelated optional plugins and keeps the required dependency closure", () => {
  const hostProvided = candidate({
    instanceId: "host-only-consumer",
    manifest: manifest("io.test.host-only", {
      provides: ["manager.core@1"],
      requires: ["host.manager.core@1", "plugin.storage@1"]
    }),
    module: { activate() {} }
  });
  const storage = candidate({
    instanceId: "storage",
    manifest: manifest("io.test.storage", { provides: ["plugin.storage@1"] }),
    module: { activate() {} }
  });
  const unrelated = candidate({
    instanceId: "unrelated",
    manifest: manifest("io.test.unrelated", { provides: ["plugin.optional@1"] }),
    module: { activate() {} }
  });

  const selected = selectReadyPluginCandidates(
    [unrelated, hostProvided, storage],
    ["manager.core@1"],
    ["host.manager.core@1"]
  );
  assert.deepEqual(selected.map(item => item.instanceId), ["host-only-consumer", "storage"]);
});

test("a non-settling optional activation is bounded and cannot block core publication", async () => {
  const runtime = createRuntime({ activationTimeoutMs: 20 });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const hung = candidate({
    instanceId: "hung",
    manifest: manifest("io.test.hung"),
    module: { async activate() { await new Promise(() => {}); } }
  });

  const result = await runtime.switch([core, hung], { readyRequires: ["manager.core@1"] });
  assert.equal(result.generation.readiness.state, "degraded");
  assert.ok(result.generation.services.services.has("manager.core@1"));
  assert.match(
    result.generation.records.find(record => record.identity.instanceId === "hung")?.error?.message ?? "",
    /activation timed out.*20ms/i
  );
  await assert.rejects(runtime.dispose(), /cleanup failed during shutdown/);
});

test("an optional runtime failure degrades health while independent core stays active", async () => {
  let failOptional = (_error: unknown): void => {};
  let failureObserved!: () => void;
  const observed = new Promise<void>(resolve => { failureObserved = resolve; });
  const runtime = createRuntime({ onRuntimeFailure: () => failureObserved() });
  const core = candidate({
    instanceId: "core",
    manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
    module: { activate(ctx) { ctx.services.provide("manager.core@1", { ready: true }); } }
  });
  const optional = candidate({
    instanceId: "optional",
    manifest: manifest("io.test.optional"),
    module: { activate(ctx) { failOptional = ctx.lifecycle.fail; } }
  });
  await runtime.switch([core, optional], { readyRequires: ["manager.core@1"] });
  failOptional(new Error("worker exhausted"));
  await observed;

  assert.equal(runtime.current().readiness.state, "degraded");
  assert.deepEqual(runtime.current().readiness.missingCapabilities, []);
  assert.ok(runtime.current().services.services.has("manager.core@1"));
  assert.equal(runtime.current().records.find(record => record.identity.instanceId === "core")?.status, "active");
  await runtime.dispose();
});

test("Effect lifecycle aborts before plugin disposers run", async () => {
  const runtime = createRuntime();
  const observed: boolean[] = [];
  await runtime.switch([candidate({
    instanceId: "signal",
    manifest: manifest("io.test.signal"),
    module: { activate(ctx) {
      ctx.effects.add(() => () => { observed.push(ctx.lifecycle.signal.aborted); });
    } }
  })]);
  await runtime.dispose();
  assert.deepEqual(observed, [true]);
});

test("GenerationRuntime records every superseded cleanup failure without skipping later scopes", async () => {
  const runtime = createRuntime();
  const disposed: string[] = [];
  const broken = (instanceId: string) => candidate({
    instanceId,
    manifest: manifest(`io.test.${instanceId}`),
    module: { activate(ctx) {
      ctx.effects.add(() => () => {
        disposed.push(instanceId);
        throw new Error(`cleanup ${instanceId} failed`);
      });
    } }
  });
  await runtime.switch([broken("one"), broken("two")]);
  const result = await runtime.switch([]);
  assert.deepEqual(disposed.sort(), ["one", "two"]);
  assert.deepEqual(result.generation.cleanupDiagnostics.map(item => item.instanceId).sort(), ["one", "two"]);
  assert.ok(result.generation.cleanupDiagnostics.every(item => item.phase === "superseded"));
});

test("GenerationRuntime shutdown attempts every active scope before reporting cleanup errors", async () => {
  const runtime = createRuntime();
  const disposed: string[] = [];
  const broken = (instanceId: string) => candidate({
    instanceId,
    manifest: manifest(`io.test.${instanceId}`),
    module: { activate(ctx) {
      ctx.effects.add(() => () => {
        disposed.push(instanceId);
        throw new Error(`shutdown ${instanceId} failed`);
      });
    } }
  });
  await runtime.switch([broken("one"), broken("two")]);
  await assert.rejects(runtime.dispose(), AggregateError);
  assert.deepEqual(disposed.sort(), ["one", "two"]);
  assert.equal(runtime.current().cleanupDiagnostics.filter(item => item.phase === "shutdown").length, 2);
});

test("GenerationRuntime removes a failed runtime component and publishes the fault", async () => {
  let reportFailure = (_error: unknown): void => {};
  let observedFailure: Promise<void>;
  let resolveFailure = (): void => {};
  observedFailure = new Promise(resolve => { resolveFailure = resolve; });
  const runtime = createRuntime({ onRuntimeFailure: () => { resolveFailure(); } });
  const provider = candidate({
    instanceId: "provider",
    manifest: manifest("io.test.provider", { provides: ["manager.core@1"] }),
    module: { activate(ctx) {
      ctx.services.provide("manager.core@1", { ready: true });
      reportFailure = ctx.lifecycle.fail;
    } }
  });
  const consumer = candidate({
    instanceId: "consumer",
    manifest: manifest("io.test.consumer", { requires: ["manager.core@1"] }),
    module: { activate(ctx) { assert.ok(ctx.services.require("manager.core@1")); } }
  });
  const independent = candidate({
    instanceId: "independent",
    manifest: manifest("io.test.independent"),
    module: { activate() {} }
  });
  await runtime.switch([provider, consumer, independent], { readyRequires: ["manager.core@1"] });
  reportFailure(new Error("child exited"));
  await observedFailure;
  const failed = runtime.current();
  assert.equal(failed.readiness.state, "degraded");
  assert.deepEqual(failed.readiness.missingCapabilities, ["manager.core@1"]);
  assert.equal(failed.records.find(record => record.identity.instanceId === "provider")?.error?.code, "runtime_failed");
  assert.equal(failed.records.find(record => record.identity.instanceId === "consumer")?.status, "waiting_dependency");
  assert.equal(failed.records.find(record => record.identity.instanceId === "independent")?.status, "active");
  assert.equal(failed.services.services.has("manager.core@1"), false);
  await runtime.dispose();
});

test("GenerationRuntime publishes required invalidation before bounded failed-plugin cleanup", async () => {
  let reportFailure = (_error: unknown): void => {};
  let observedRequiredReady: boolean | undefined;
  const observed = new Promise<void>(resolve => {
    const runtime = createRuntime({
      onRuntimeFailure: event => {
        observedRequiredReady = event.generation.readiness.missingCapabilities.length === 0;
        resolve();
      }
    });
    void runtime.switch([candidate({
      instanceId: "core",
      manifest: manifest("io.test.core", { provides: ["manager.core@1"] }),
      policy: {
        restart: { mode: "never", maxAttempts: 0, windowMs: 60_000, initialBackoffMs: 0, maximumBackoffMs: 1 },
        resources: { maxChildProcesses: 1, shutdownTimeoutMs: 20 }
      },
      module: { activate(ctx) {
        ctx.services.provide("manager.core@1", { ready: true });
        reportFailure = ctx.lifecycle.fail;
        ctx.effects.add(() => async () => { await new Promise(() => {}); }, "hung required cleanup");
      } }
    })], { readyRequires: ["manager.core@1"] }).then(() => reportFailure(new Error("core failed")));
  });

  await Promise.race([
    observed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("required invalidation publication timed out")), 100))
  ]);
  assert.equal(observedRequiredReady, false);
});

for (const warmCore of [false, true]) {
  test(`a failed sibling cannot cancel a healthy feature using the same core (warm=${warmCore})`, async () => {
    const runtime = createRuntime();
    const core = candidate({ instanceId: "core", manifest: manifest("io.test.core", { provides: ["test.core@1"] }),
      module: { activate(ctx) { ctx.services.provide("test.core@1", {}); } } });
    const good = candidate({ instanceId: "good", manifest: manifest("io.test.good", { requires: ["test.core@1"], provides: ["test.good@1"] }),
      module: { activate(ctx) { ctx.services.require("test.core@1"); ctx.services.provide("test.good@1", "available"); } } });
    const broken = candidate({ instanceId: "broken", manifest: manifest("io.test.broken", { requires: ["test.core@1"] }),
      module: { activate() { throw new Error("one feature failed"); } } });
    try {
      if (warmCore) await runtime.switch([core], { readyRequires: ["test.core@1"] });
      const coreActivation = runtime.current().records.find(record => record.identity.instanceId === "core")?.identity.activationId;
      const result = await runtime.switch([core, broken, good], { readyRequires: ["test.core@1"] });
      assert.equal(result.generation.services.services.get("test.good@1")?.value, "available");
      assert.deepEqual(result.generation.readiness.missingCapabilities, []);
      assert.equal(result.generation.records.find(record => record.identity.instanceId === "broken")?.status, "failed");
      if (warmCore) assert.equal(result.generation.records.find(record => record.identity.instanceId === "core")?.identity.activationId, coreActivation);
    } finally { await runtime.dispose(); }
  });
}

test("a feature missing its own required service does not suspend its healthy provider", async () => {
  const runtime = createRuntime();
  try {
    const result = await runtime.switch([
      candidate({ instanceId: "core", manifest: manifest("io.test.core", { provides: ["test.core@1"] }),
        module: { activate(ctx) { ctx.services.provide("test.core@1", {}); } } }),
      candidate({ instanceId: "broken", manifest: manifest("io.test.broken", { requires: ["test.core@1", "test.missing@1"] }), module: { activate() {} } })
    ], { readyRequires: ["test.core@1"] });
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "core")?.status, "active");
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "broken")?.status, "waiting_dependency");
  } finally { await runtime.dispose(); }
});

test("removing one optional capability from a retained provider rebuilds consumers without stale references", async () => {
  const runtime = createRuntime();
  const provider = (revision: string) => candidate({ instanceId: "provider", revision,
    manifest: manifest("io.test.provider", { provides: revision === "one" ? ["test.optional@1"] : ["test.other@1"] }),
    module: { activate(ctx) { ctx.services.provide(revision === "one" ? "test.optional@1" : "test.other@1", revision); } } });
  const consumer = candidate({ instanceId: "consumer",
    manifest: manifest("io.test.consumer", { optional: ["test.optional@1"], provides: ["test.consumer@1"] }),
    module: { activate(ctx) { ctx.services.provide("test.consumer@1", ctx.services.optional("test.optional@1") ?? "absent"); } } });
  try {
    await runtime.switch([provider("one"), consumer]);
    assert.equal(runtime.current().services.services.get("test.consumer@1")?.value, "one");
    const result = await runtime.switch([provider("two"), consumer]);
    assert.equal(result.generation.services.services.has("test.optional@1"), false);
    assert.equal(result.generation.services.services.get("test.consumer@1")?.value, "absent");
  } finally { await runtime.dispose(); }
});

test("a provider update and old consumers roll back together while a new feature uses the retained provider", async () => {
  const runtime = createRuntime();
  const provider = (revision: string) => candidate({ instanceId: "provider", revision,
    manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
    module: { activate(ctx) { ctx.services.provide("test.value@1", revision); } } });
  const consumer = candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"], provides: ["test.consumer@1"] }),
    module: { activate(ctx) { const value = ctx.services.require<string>("test.value@1"); if (value === "two") throw new Error("cannot migrate consumer"); ctx.services.provide("test.consumer@1", value); } } });
  const fresh = candidate({ instanceId: "fresh", manifest: manifest("io.test.fresh", { requires: ["test.value@1"], provides: ["test.fresh@1"] }),
    module: { activate(ctx) { ctx.services.provide("test.fresh@1", ctx.services.require("test.value@1")); } } });
  try {
    await runtime.switch([provider("one"), consumer]);
    const before = runtime.current().records.find(record => record.identity.instanceId === "consumer")!.identity.activationId;
    const result = await runtime.switch([provider("two"), consumer, fresh]);
    for (const capability of ["test.value@1", "test.consumer@1", "test.fresh@1"]) assert.equal(result.generation.services.services.get(capability)?.value, "one");
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "consumer")?.identity.activationId, before);
  } finally { await runtime.dispose(); }
});

test("provider effect failure withdraws already prepared consumers but keeps an unrelated feature", async () => {
  const runtime = createRuntime();
  try {
    const result = await runtime.switch([
      candidate({ instanceId: "provider", manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
        module: { activate(ctx) { ctx.services.provide("test.value@1", {}); ctx.effects.add(() => { throw new Error("provider startup failed"); }); } } }),
      candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"], provides: ["test.consumer@1"] }),
        module: { activate(ctx) { ctx.services.require("test.value@1"); ctx.services.provide("test.consumer@1", {}); } } }),
      candidate({ instanceId: "independent", manifest: manifest("io.test.independent", { provides: ["test.independent@1"] }),
        module: { activate(ctx) { ctx.services.provide("test.independent@1", {}); } } })
    ]);
    assert.equal(result.generation.services.services.has("test.value@1"), false);
    assert.equal(result.generation.services.services.has("test.consumer@1"), false);
    assert.equal(result.generation.services.services.has("test.independent@1"), true);
  } finally { await runtime.dispose(); }
});

test("an unconfirmed prepared provider rollback fences later revisions without blocking unrelated features", async () => {
  const runtime = createRuntime();
  let release!: () => void;
  const oldCandidateJoin = new Promise<void>(resolve => { release = resolve; });
  let thirdStarted = 0;
  const provider = (revision: string) => candidate({ instanceId: "provider", revision,
    manifest: manifest("io.test.provider", { provides: ["test.value@1"] }),
    policy: { restart: { mode: "never", maxAttempts: 0, windowMs: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
      resources: { maxChildProcesses: 0, shutdownTimeoutMs: 20 } },
    module: { activate(ctx) {
      ctx.services.provide("test.value@1", revision);
      if (revision === "two") ctx.effects.adopt(() => oldCandidateJoin, "prepared candidate worker");
      if (revision === "three") thirdStarted++;
    } } });
  const consumer = candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.value@1"] }),
    module: { activate(ctx) { if (ctx.services.require("test.value@1") === "two") throw new Error("candidate consumer activation failed"); } } });
  const independent = candidate({ instanceId: "independent", manifest: manifest("io.test.independent", { provides: ["test.independent@1"] }),
    module: { activate(ctx) { ctx.services.provide("test.independent@1", {}); } } });
  try {
    await runtime.switch([provider("one"), consumer]);
    const rejected = await runtime.switch([provider("two"), consumer]);
    assert.equal(rejected.generation.services.services.get("test.value@1")?.value, "one");
    assert.ok(rejected.generation.cleanupDiagnostics.some(diagnostic => diagnostic.instanceId === "provider"
      && diagnostic.phase === "rollback" && /prepared candidate worker.*20ms/.test(diagnostic.message)));
    const fenced = await runtime.switch([provider("three"), consumer, independent]);
    assert.equal(thirdStarted, 0);
    assert.equal(fenced.generation.services.services.get("test.value@1")?.value, "one");
    assert.equal(fenced.generation.services.services.has("test.independent@1"), true);
    assert.match(fenced.generation.records.find(record => record.identity.instanceId === "provider")?.error?.message ?? "", /retirement is unconfirmed/);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    const confirmed = await runtime.switch([provider("three"), consumer, independent]);
    assert.equal(thirdStarted, 1);
    assert.equal(confirmed.generation.services.services.get("test.value@1")?.value, "three");
  } finally { release(); await new Promise<void>(resolve => setImmediate(resolve)); await runtime.dispose(); }
});

for (const phase of ["preparation", "effect", "afterPublish"] as const) {
  test(`hung ${phase} releases the publication queue while retaining its own unfinished owner`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let lateActivate = false;
    let lateDisposed = false;
    const hung = candidate({ instanceId: "hung", manifest: manifest("io.test.hung"), module: { activate(ctx) {
      lateActivate = true;
      if (phase === "effect") ctx.effects.add(async () => { await gate; return () => { lateDisposed = true; }; }, "late fixture");
      if (phase === "afterPublish") ctx.publication.add({ publish() {}, rollback() {}, async afterPublish() { await gate; } });
    } } });
    const runtime = new GenerationRuntime({ host: "manager", activationTimeoutMs: 30, executor: {
      async prepare(item) { if (phase === "preparation" && item.instanceId === "hung") await gate; return testExecutor.prepare(item); }
    } });
    try {
      const result = await runtime.switch([hung]);
      assert.equal(result.generation.records.find(record => record.identity.instanceId === "hung")?.status, "failed");
      assert.equal(await runtime.publishSourcePatch(result.generation.id, async () => "unrelated publication"), "unrelated publication");
      const blocked = await runtime.switch([hung]);
      assert.match(blocked.generation.records.find(record => record.identity.instanceId === "hung")?.error?.message ?? "", /retirement is unconfirmed/);
      release();
      for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve));
      if (phase === "preparation") assert.equal(lateActivate, false);
      if (phase === "effect") assert.equal(lateDisposed, true);
    } finally { release(); for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve)); await runtime.dispose(); }
  });
}

test("a lifecycle failure interrupts pending post-publication startup before its deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failed!: () => void;
  const entered = new Promise<void>(resolve => { failed = resolve; });
  let context!: Parameters<PluginModule["activate"]>[0];
  const runtime = createRuntime({ activationTimeoutMs: 5_000 });
  try {
    const switching = runtime.switch([candidate({ instanceId: "failed", manifest: manifest("io.test.failed"), module: { activate(ctx) {
      context = ctx;
      ctx.publication.add({ publish() {}, rollback() {}, async afterPublish() { failed(); await gate; } });
    } } })]);
    await entered;
    context.lifecycle.fail(new Error("worker failed"));
    const result = await switching;
    assert.equal(result.generation.records[0]?.status, "failed");
    assert.match(result.generation.records[0]?.error?.message ?? "", /worker failed/);
    assert.throws(() => context.services.provide("unavailable@1", {}), /worker failed/);
  } finally { release(); for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve)); await runtime.dispose(); }
});

test("required capability report policy preserves healthy services and leaves failed dependents waiting", async () => {
  const runtime = createRuntime({ readyRequires: ["test.core@1", "test.diagnostics@1"] });
  let consumerActivations = 0, cleanups = 0;
  const core = candidate({ instanceId: "core", manifest: manifest("io.test.core", { provides: ["test.core@1"] }), module: {
    activate(ctx) { ctx.services.provide("test.core@1", { read: () => "core survives" }); ctx.effects.add(() => () => { cleanups++; }); }
  } });
  const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy", { provides: ["test.healthy@1"] }), module: {
    activate(ctx) { ctx.services.provide("test.healthy@1", { read: () => "independent survives" }); ctx.effects.add(() => () => { cleanups++; }); }
  } });
  const diagnostics = candidate({ instanceId: "diagnostics", manifest: manifest("io.test.diagnostics", { provides: ["test.diagnostics@1"] }), module: {
    activate() { throw new Error("diagnostics fixture failed"); }
  } });
  const consumer = candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.diagnostics@1"] }), module: {
    activate() { consumerActivations++; }
  } });
  try {
    const result = await runtime.switch([core, diagnostics, consumer, healthy], { requiredCapabilityPolicy: "report" });
    assert.equal(result.generation.sequence, 1);
    assert.equal(result.generation.readiness.state, "degraded");
    assert.deepEqual(result.generation.readyRequires, ["test.core@1", "test.diagnostics@1"]);
    assert.deepEqual(result.generation.readiness.missingCapabilities, ["test.diagnostics@1"]);
    assert.equal(result.generation.records.find(item => item.identity.instanceId === "diagnostics")?.status, "failed");
    assert.equal(result.generation.records.find(item => item.identity.instanceId === "consumer")?.status, "waiting_dependency");
    assert.equal(consumerActivations, 0);
    assert.equal((result.generation.services.services.get("test.core@1")!.value as { read(): string }).read(), "core survives");
    assert.equal((result.generation.services.services.get("test.healthy@1")!.value as { read(): string }).read(), "independent survives");
  } finally { await runtime.dispose(); }
  assert.equal(cleanups, 2);
});

test("required capability report policy marks absent required providers degraded even when every present plugin is active", async () => {
  const runtime = createRuntime({ readyRequires: ["test.diagnostics@1"] });
  const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy"), module: { activate() {} } });
  try {
    const { generation } = await runtime.switch([healthy], { requiredCapabilityPolicy: "report" });
    assert.equal(generation.readiness.state, "degraded");
    assert.deepEqual(generation.readiness.missingCapabilities, ["test.diagnostics@1"]);
    assert.equal(generation.records.length, 1);
    assert.equal(generation.records[0]!.status, "active");
  } finally { await runtime.dispose(); }
});

test("required capability report policy recomputes required readiness after a local publication failure", async () => {
  const runtime = createRuntime({ readyRequires: ["test.diagnostics@1"] });
  let rolledBack = 0;
  const diagnostics = candidate({ instanceId: "diagnostics", manifest: manifest("io.test.diagnostics", { provides: ["test.diagnostics@1"] }), module: {
    activate(ctx) {
      ctx.services.provide("test.diagnostics@1", { ready: true });
      ctx.publication.add({ publish() { throw new Error("diagnostics publication fixture failed"); }, rollback() { rolledBack++; } });
    }
  } });
  const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy", { provides: ["test.healthy@1"] }), module: {
    activate(ctx) { ctx.services.provide("test.healthy@1", { ready: true }); }
  } });
  try {
    const { generation } = await runtime.switch([diagnostics, healthy], { requiredCapabilityPolicy: "report" });
    assert.equal(generation.readiness.state, "degraded");
    assert.deepEqual(generation.readiness.missingCapabilities, ["test.diagnostics@1"]);
    assert.equal(generation.services.services.has("test.diagnostics@1"), false);
    assert.equal(generation.services.services.has("test.healthy@1"), true);
    assert.equal(generation.records.find(item => item.identity.instanceId === "diagnostics")?.status, "failed");
    assert.equal(rolledBack, 1);
  } finally { await runtime.dispose(); }
});

test("required capability report policy keeps the same core activation across ready-only and full healthy publication", async () => {
  const requires = ["test.core@1", "test.diagnostics@1"];
  const runtime = createRuntime({ readyRequires: requires });
  let activations = 0, disposals = 0, consumerActivations = 0;
  const core = candidate({ instanceId: "core", manifest: manifest("io.test.core", { provides: ["test.core@1"] }), module: {
    activate(ctx) { activations++; ctx.services.provide("test.core@1", { ready: true }); ctx.effects.add(() => () => { disposals++; }); }
  } });
  const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy", { provides: ["test.healthy@1"] }), module: {
    activate(ctx) { ctx.services.provide("test.healthy@1", { ready: true }); }
  } });
  const consumer = candidate({ instanceId: "consumer", manifest: manifest("io.test.consumer", { requires: ["test.diagnostics@1"] }), module: {
    activate() { consumerActivations++; }
  } });
  const later = candidate({ instanceId: "later", manifest: manifest("io.test.later"), module: { activate() {} } });
  try {
    const readyOnly = selectReadyPluginCandidates([core, healthy, consumer], requires);
    assert.deepEqual(readyOnly.map(item => item.instanceId), ["core"]);
    await runtime.switch(readyOnly, { requiredCapabilityPolicy: "report" });
    const first = runtime.current(), activation = first.records.find(x => x.identity.instanceId === "core")!.identity.activationId;
    assert.equal(first.readiness.state, "degraded"); assert.deepEqual(first.readiness.missingCapabilities, ["test.diagnostics@1"]);
    await runtime.switch([core, healthy, consumer], { requiredCapabilityPolicy: "report" });
    const full = runtime.current();
    assert.equal(full.records.find(x => x.identity.instanceId === "core")!.identity.activationId, activation);
    assert.equal(full.records.find(x => x.identity.instanceId === "healthy")!.status, "active");
    assert.equal(full.records.find(x => x.identity.instanceId === "consumer")!.status, "waiting_dependency");
    assert.equal(activations, 1); assert.equal(disposals, 0); assert.equal(consumerActivations, 0);
    assert.deepEqual(full.readiness.missingCapabilities, ["test.diagnostics@1"]);
    await assert.rejects(runtime.switch([core, healthy, consumer, later]), RequiredPluginCapabilitiesUnavailableError);
    assert.equal(runtime.current().id, full.id); assert.equal(disposals, 0);
    await runtime.switch([core, healthy, consumer, later], { requiredCapabilityPolicy: "report" });
    assert.equal(runtime.current().records.find(x => x.identity.instanceId === "later")!.status, "active");
    assert.equal(runtime.current().records.find(x => x.identity.instanceId === "core")!.identity.activationId, activation);
    assert.equal(activations, 1); assert.equal(disposals, 0);
  } finally { await runtime.dispose(); }
  assert.equal(disposals, 1);
});

test("required capability report policy publishes an empty first generation with truthful missing readiness", async () => {
  const runtime = createRuntime({ readyRequires: ["test.diagnostics@1"] });
  try {
    const initial = runtime.current();
    const reported = await runtime.switch([], { requiredCapabilityPolicy: "report" });
    assert.equal(reported.changed, true); assert.equal(reported.generation.sequence, 1);
    assert.notEqual(reported.generation.id, initial.id);
    assert.equal(reported.generation.readiness.state, "degraded");
    assert.deepEqual(reported.generation.readyRequires, ["test.diagnostics@1"]);
    assert.deepEqual(reported.generation.readiness.missingCapabilities, ["test.diagnostics@1"]);
    const unchanged = await runtime.switch([], { requiredCapabilityPolicy: "report" });
    assert.equal(unchanged.changed, false); assert.equal(unchanged.generation.id, reported.generation.id);
    const added = candidate({ instanceId: "added", manifest: manifest("io.test.added"), module: { activate() {} } });
    await assert.rejects(runtime.switch([added]), RequiredPluginCapabilitiesUnavailableError);
    assert.equal(runtime.current().id, reported.generation.id);
  } finally { await runtime.dispose(); }
});

test("required capability report policy never bypasses the source and identity publication fence", async () => {
  const runtime = createRuntime({ readyRequires: ["test.diagnostics@1"] });
  let assertions = 0, cleanups = 0;
  const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy"), module: {
    activate(ctx) { ctx.effects.add(() => () => { cleanups++; }); }
  } });
  try {
    await assert.rejects(runtime.switch([healthy], { requiredCapabilityPolicy: "report", beforePublish() {
      assertions++; throw new Error("Source assertion revoked");
    } }), /Source assertion revoked/);
    assert.equal(assertions, 1); assert.equal(runtime.current().sequence, 0); assert.equal(cleanups, 1);
  } finally { await runtime.dispose(); }
});

for (const shape of ["empty", "nonempty"] as const) {
  test("required capability report policy preserves default strict enforcement for identical " + shape + " input", async () => {
    const runtime = createRuntime({ readyRequires: ["test.diagnostics@1"] });
    const healthy = candidate({ instanceId: "healthy", manifest: manifest("io.test.healthy"), module: { activate() {} } });
    const input = shape === "empty" ? [] : [healthy];
    try {
      await runtime.switch(input, { requiredCapabilityPolicy: "report" });
      const published = runtime.current();
      assert.equal(published.sequence, 1);
      assert.equal(published.readiness.state, "degraded");
      assert.deepEqual(published.readiness.missingCapabilities, ["test.diagnostics@1"]);
      await assert.rejects(runtime.switch(input), RequiredPluginCapabilitiesUnavailableError);
      assert.equal(runtime.current().id, published.id);
      assert.equal(runtime.current().sequence, published.sequence);
      const reportedAgain = await runtime.switch(input, { requiredCapabilityPolicy: "report" });
      assert.equal(reportedAgain.changed, false);
      assert.equal(reportedAgain.generation.id, published.id);
    } finally { await runtime.dispose(); }
  });
}
