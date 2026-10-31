import assert from "node:assert/strict";
import test from "node:test";
import { isolateCapabilityGraph } from "./capabilityGraphIsolation.js";
import { GenerationRuntime, selectReadyPluginCandidates } from "./generationRuntime.js";
import type { PluginCandidate, PluginModule } from "./types.js";

function candidate(id: string, provides: string[] = [], requires: string[] = [], optional: string[] = []): PluginCandidate {
  return { instanceId: id, revision: "one", config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
    manifest: { schemaVersion: 2, id: `io.test.${id}`, version: "1.0.0", permissions: [], provides, requires, optional,
      entries: { manager: { execution: "in_process", module: "fixture.mjs" } } } };
}
const executor = { async prepare(item: PluginCandidate): Promise<PluginModule> {
  return { activate(context) { for (const capability of item.manifest.provides) context.services.provide(capability, item.revision); } };
} };

test("an optional required-dependency cycle cannot block ready selection or the independent core", async () => {
  const core = candidate("core", ["core@1"]), left = candidate("left", ["left@1"], ["right@1"]), right = candidate("right", ["right@1"], ["left@1"]);
  assert.deepEqual(selectReadyPluginCandidates([core, left, right], ["core@1"]).map(item => item.instanceId), ["core"]);
  const runtime = new GenerationRuntime({ host: "manager", executor });
  try {
    const result = await runtime.switch([core, left, right], { readyRequires: ["core@1"] });
    assert.equal(result.generation.services.services.has("core@1"), true);
    assert.equal(result.generation.records.filter(record => record.status === "failed").length, 2);
    assert.deepEqual(result.generation.readiness.missingCapabilities, []);
  } finally { await runtime.dispose(); }
});

test("a new ambiguous capability rejects every contender instead of choosing an arbitrary provider", async () => {
  const core = candidate("core", ["core@1"]), left = candidate("left", ["shared@1"]), right = candidate("right", ["shared@1"]);
  const isolated = isolateCapabilityGraph([core, left, right], new Set());
  assert.deepEqual(isolated.candidates.map(item => item.instanceId), ["core"]);
  assert.deepEqual([...isolated.diagnostics.keys()], ["left", "right"]);
  const runtime = new GenerationRuntime({ host: "manager", executor });
  try {
    const result = await runtime.switch([core, left, right], { readyRequires: ["core@1"] });
    assert.equal(result.generation.services.services.has("shared@1"), false);
    assert.equal(result.generation.records.filter(record => record.status === "failed").length, 2);
  } finally { await runtime.dispose(); }
});

test("a conflicting update retains its confirmed old revision without replacing the existing provider", async () => {
  const core = candidate("core", ["core@1"]), feature = candidate("feature", ["feature@1"]);
  const runtime = new GenerationRuntime({ host: "manager", executor });
  try {
    await runtime.switch([core, feature], { readyRequires: ["core@1"] });
    const activation = runtime.current().records.find(record => record.identity.instanceId === "feature")!.identity.activationId;
    const bad = { ...candidate("feature", ["feature@1", "core@1"]), revision: "bad" };
    const result = await runtime.switch([core, bad], { readyRequires: ["core@1"] });
    assert.equal(result.generation.services.services.get("core@1")?.providerInstanceId, "core");
    assert.equal(result.generation.services.services.get("feature@1")?.value, "one");
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "feature")?.identity.activationId, activation);
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "feature")?.error?.code, "update_failed_using_previous_revision");
  } finally { await runtime.dispose(); }
});

test("a rejected cyclic update cannot delete its otherwise valid confirmed consumer", async () => {
  const a = candidate("a", ["a@1"]), b = candidate("b", ["b@1"], ["a@1"]);
  const runtime = new GenerationRuntime({ host: "manager", executor });
  try {
    await runtime.switch([a, b]);
    const old = runtime.current().records.map(record => record.identity.activationId);
    const changed = { ...candidate("a", ["a@1"], ["b@1"]), revision: "bad" };
    const result = await runtime.switch([changed, b]);
    assert.deepEqual(result.generation.records.map(record => record.identity.activationId), old);
    assert.equal(result.generation.services.services.size, 2);
  } finally { await runtime.dispose(); }
});

test("optional ordering cycles keep valid functions active and expose the skipped preference", async () => {
  const core = candidate("core", ["core@1"], [], ["feature@1"]), feature = candidate("feature", ["feature@1"], ["core@1"]);
  const runtime = new GenerationRuntime({ host: "manager", executor });
  try {
    const result = await runtime.switch([core, feature], { readyRequires: ["core@1"] });
    assert.equal(result.generation.records.every(record => record.status === "active"), true);
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "core")?.error?.code, "optional_dependency_order_skipped");
    assert.equal(result.generation.services.services.size, 2);
  } finally { await runtime.dispose(); }
});

test("a plugin cannot shadow a Host capability", () => {
  const plugin = candidate("bad", ["host.value@1"]);
  const result = isolateCapabilityGraph([plugin], new Set(["host.value@1"]));
  assert.equal(result.candidates.length, 0);
  assert.match(result.diagnostics.get("bad")!.error.message, /conflicts with host/);
});
