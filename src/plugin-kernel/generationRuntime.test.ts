import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRuntime } from "./generationRuntime.js";
import type { PluginCandidate, PluginManifest } from "./types.js";

function manifest(id: string, input: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1, id, version: "1.0.0", entries: { manager: "./manager.mjs" },
    provides: [], requires: [], optional: [], permissions: [], ...input
  };
}
function candidate(input: Partial<PluginCandidate> & Pick<PluginCandidate, "instanceId" | "manifest" | "module">): PluginCandidate {
  return { revision: "one", config: {}, ...input };
}

test("GenerationRuntime publishes services and contributions atomically", async () => {
  const lifecycle: string[] = [];
  const runtime = new GenerationRuntime({ host: "manager" });
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
  const runtime = new GenerationRuntime({ host: "manager" });
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

test("GenerationRuntime fails closed when permissions were not granted", async () => {
  const runtime = new GenerationRuntime({ host: "manager", grantedPermissions: () => [] });
  const result = await runtime.switch([
    candidate({
      instanceId: "desktop", manifest: manifest("io.test.desktop", { permissions: ["desktop.ipc.codex"] }),
      module: { activate() {} }
    })
  ]);
  assert.equal(result.generation.records[0]?.status, "failed");
  assert.match(result.generation.records[0]?.error?.message ?? "", /not granted/);
});

test("GenerationRuntime keeps the previous component when effect publication fails", async () => {
  const runtime = new GenerationRuntime({ host: "manager" });
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
  const runtime = new GenerationRuntime({ host: "manager" });
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
    "stop-provider-one", "stop-consumer-one"
  ]);
  await runtime.dispose();
  assert.equal(lifecycle.filter(item => item === "start-independent").length, 1);
  assert.equal(lifecycle.filter(item => item === "stop-independent").length, 1);
});
