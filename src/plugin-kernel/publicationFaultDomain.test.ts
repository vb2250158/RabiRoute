import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRuntime } from "./generationRuntime.js";
import type { PluginCandidate, PluginContext, PluginModule } from "./types.js";

function fixture() {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const runtime = new GenerationRuntime({ host: "manager",
    executor: { prepare: async candidate => modules.get(candidate)! } });
  function plugin(id: string, revision = "one", options: { provides?: readonly string[]; requires?: readonly string[]; optional?: readonly string[];
    packageId?: string; web?: boolean; value?: unknown; activate?: (context: PluginContext) => void; shutdownTimeoutMs?: number } = {}) {
    const provides = options.provides ?? [`fixture.${id}@1`];
    const candidate: PluginCandidate = { instanceId: id, revision, config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: options.packageId ?? `io.fixture.${id}`, version: "1.0.0",
        entries: { manager: { execution: "in_process", module: "fixture.mjs" }, ...(options.web ? { web: { execution: "in_process" as const, module: "web.mjs" } } : {}) },
        provides, requires: options.requires ?? [], optional: options.optional ?? [], permissions: [] },
      policy: { restart: { mode: "never", maxAttempts: 0, windowMs: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
        resources: { maxChildProcesses: 0, shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1000 } } };
    modules.set(candidate, { activate(context) { for (const capability of provides) context.services.provide(capability, options.value ?? `${id}:${revision}`); options.activate?.(context); } });
    return candidate;
  }
  return { runtime, plugin };
}

test("an optional publication failure publishes independent healthy additions and keeps them callable on retry", async () => {
  const { runtime, plugin } = fixture();
  const core = plugin("core"), healthy = plugin("healthy");
  let failures = 0;
  const bad = plugin("bad", "one", { activate(context) { context.publication.add({ publish() { failures++; throw new Error("optional pointer failure"); }, rollback() {} }); } });
  try {
    await runtime.switch([core], { readyRequires: ["fixture.core@1"] });
    const first = await runtime.switch([core, bad, healthy], { readyRequires: ["fixture.core@1"] });
    const active = first.generation.records.find(record => record.identity.instanceId === "healthy")!.identity.activationId;
    assert.equal(first.generation.services.services.get("fixture.healthy@1")?.value, "healthy:one");
    assert.equal(first.generation.records.find(record => record.identity.instanceId === "bad")?.error?.code, "publication_failed");
    const next = await runtime.switch([core, bad, healthy, plugin("another")], { readyRequires: ["fixture.core@1"] });
    assert.equal(next.generation.records.find(record => record.identity.instanceId === "healthy")!.identity.activationId, active);
    assert.equal(next.generation.services.services.get("fixture.another@1")?.value, "another:one");
    assert.equal(failures, 2);
    assert.equal(await runtime.publishSourcePatch(next.generation.id, async () => "healthy request"), "healthy request");
  } finally { await runtime.dispose(); }
});

test("a failed owner upgrade preserves its old revision while independent native pointers commit once", async () => {
  const { runtime, plugin } = fixture();
  let pointer = "old", oldStops = 0, observed: Promise<{ pointer: string; service: unknown }> | undefined;
  const old = plugin("owner", "old", { activate(context) { context.effects.adopt(() => { oldStops++; }); } });
  const next = plugin("owner", "new", { activate(context) { context.publication.add({ publish() { pointer = "bad"; throw new Error("upgrade pointer failure"); }, rollback() { pointer = "old"; } }); } });
  const healthy = plugin("healthy", "one", { activate(context) { context.publication.add({ publish() {
    observed = new Promise(resolve => queueMicrotask(() => resolve({ pointer, service: runtime.current().services.services.get("fixture.healthy@1")?.value })));
  }, rollback() {} }); } });
  try {
    await runtime.switch([old]);
    const result = await runtime.switch([next, healthy]);
    assert.equal(pointer, "old"); assert.equal(oldStops, 0);
    assert.equal(result.generation.services.services.get("fixture.owner@1")?.value, "owner:old");
    assert.equal(result.generation.records.find(record => record.identity.instanceId === "owner")?.error?.code, "update_failed_using_previous_revision");
    assert.deepEqual(await observed, { pointer: "old", service: "healthy:one" });
  } finally { await runtime.dispose(); }
});

test("publication failure rolls back consumers bound to the failed candidate without rolling back its upstream provider", async () => {
  const { runtime, plugin } = fixture();
  const core = plugin("core"), upstream = plugin("upstream");
  const bad = plugin("bad", "one", { requires: ["fixture.upstream@1"], activate(context) {
    context.services.require("fixture.upstream@1");
    context.publication.add({ publish() { throw new Error("provider failed"); }, rollback() {} });
  } });
  const consumer = plugin("consumer", "one", { optional: ["fixture.bad@1"], activate(context) { context.services.optional("fixture.bad@1"); } });
  const absentOptional = plugin("healthy", "one", { optional: ["fixture.absent@1"] });
  try {
    await runtime.switch([core]);
    const { generation } = await runtime.switch([core, upstream, bad, consumer, absentOptional]);
    assert.equal(generation.services.services.has("fixture.upstream@1"), true);
    assert.equal(generation.services.services.has("fixture.healthy@1"), true);
    assert.equal(generation.services.services.has("fixture.consumer@1"), false);
    assert.equal(generation.services.services.has("fixture.bad@1"), false);
  } finally { await runtime.dispose(); }
});

for (const phase of ["activation", "effect", "publication"] as const) for (const namespace of ["capability", "contribution"] as const) {
  test(`${phase} fallback closes the old ${namespace} namespace through related prepared replacements`, async () => {
    const { runtime, plugin } = fixture();
    const slot = (context: PluginContext, value: string) => { if (namespace === "contribution") context.contributions.register({ kind: "fixture", id: value, value }); };
    const first = plugin("z-owner", "old", { provides: namespace === "capability" ? ["fixture.slot-a@1"] : undefined,
      activate: context => slot(context, "slot-a") });
    const second = plugin("a-taker", "old", { provides: namespace === "capability" ? ["fixture.slot-b@1"] : undefined,
      activate: context => slot(context, "slot-b") });
    const failing = plugin("z-owner", "new", { provides: namespace === "capability" ? ["fixture.slot-c@1"] : undefined,
      activate(context) {
        slot(context, "slot-c");
        if (phase === "activation") throw new Error("controlled namespace update failure");
        if (phase === "effect") context.effects.add(() => { throw new Error("controlled namespace update failure"); });
        if (phase === "publication") context.publication.add({ publish() { throw new Error("controlled namespace update failure"); }, rollback() {} });
      } });
    const taking = plugin("a-taker", "new", { provides: namespace === "capability" ? ["fixture.slot-a@1"] : undefined,
      activate: context => slot(context, "slot-a") });
    const following = plugin("b-taker", "new", { provides: namespace === "capability" ? ["fixture.slot-b@1"] : undefined,
      activate: context => slot(context, "slot-b") });
    const healthy = plugin("healthy");
    try {
      await runtime.switch([first, second]);
      const { generation } = await runtime.switch([failing, taking, following, healthy]);
      assert.equal(generation.records.find(record => record.identity.instanceId === "z-owner")?.identity.revision, "old");
      assert.equal(generation.records.find(record => record.identity.instanceId === "a-taker")?.identity.revision, "old");
      assert.equal(generation.records.find(record => record.identity.instanceId === "b-taker")?.status, "failed");
      assert.equal(generation.services.services.has("fixture.healthy@1"), true);
      if (namespace === "capability") assert.equal(generation.services.services.get("fixture.slot-a@1")?.value, "z-owner:old");
      else assert.equal(generation.contributions.contributions.filter(item => item.id === "slot-a").length, 1);
    } finally { await runtime.dispose(); }
  });
}

for (const rollback of ["undefined", "cpu"] as const) {
  test(`unconfirmed ${rollback} rollback withdraws its old shared group and dependents while a new healthy group commits`, async () => {
    const { runtime, plugin } = fixture();
    const core = plugin("core"), packageId = "io.fixture.shared";
    let pointer = "old";
    const owner = plugin("owner", "old", { packageId, web: true, value: { read: () => pointer } });
    const sibling = plugin("sibling", "old", { packageId, web: true, provides: [] });
    const consumer = plugin("consumer", "old", { requires: ["fixture.owner@1"] });
    const update = plugin("owner", "new", { packageId, web: true, activate(context) { context.publication.add({
      publish() { pointer = "bad"; throw new Error("publication failed"); }, rollback() {
        if (rollback === "cpu") { const end = performance.now() + 250; while (performance.now() < end) { /* controlled CPU fault */ } }
        throw undefined;
      }
    }); } });
    try {
      await runtime.switch([core, owner, sibling, consumer], { readyRequires: ["fixture.core@1"] });
      const { generation } = await runtime.switch([core, update, plugin("sibling", "new", { packageId, web: true, provides: [] }), consumer, plugin("healthy")],
        { readyRequires: ["fixture.core@1"] });
      assert.equal(pointer, "bad");
      assert.equal(generation.services.services.has("fixture.owner@1"), false);
      assert.equal(generation.services.services.has("fixture.consumer@1"), false);
      assert.equal(generation.services.services.has("fixture.healthy@1"), true);
      for (const id of ["owner", "sibling", "consumer"]) assert.equal(generation.records.find(record => record.identity.instanceId === id)?.error?.code, "publication_rollback_unconfirmed");
      assert.equal(await runtime.publishSourcePatch(generation.id, async () => "unrelated request"), "unrelated request");
    } finally { await assert.rejects(runtime.dispose(), /Plugin cleanup failed/); }
  });
}

test("a genuinely required publication failure remains global and restores healthy native pointers before cleanup", async () => {
  const { runtime, plugin } = fixture();
  let healthyPointer = "old";
  const core = plugin("core"), healthy = plugin("a-healthy", "one", { activate(context) { context.publication.add({ publish() { healthyPointer = "new"; }, rollback() { healthyPointer = "old"; } }); } });
  const bad = plugin("z-required", "one", { activate(context) { context.publication.add({ publish() { throw new Error("required failed"); }, rollback() {} }); } });
  try {
    await runtime.switch([core]); const previous = runtime.current();
    await assert.rejects(runtime.switch([core, healthy, bad], { readyRequires: ["fixture.z-required@1"] }), /Required plugin capabilities/);
    assert.equal(healthyPointer, "old"); assert.equal(runtime.current(), previous);
    assert.equal(runtime.current().services.services.has("fixture.a-healthy@1"), false);
  } finally { await runtime.dispose(); }
});

test("a revoked global source fence runs once and prevents every candidate publication", async () => {
  const { runtime, plugin } = fixture();
  let publications = 0, assertions = 0;
  const core = plugin("core"), healthy = plugin("healthy", "one", { activate(context) { context.publication.add({ publish() { publications++; }, rollback() {} }); } });
  try {
    await runtime.switch([core]); const previous = runtime.current();
    await assert.rejects(runtime.switch([core, healthy], { beforePublish() { assertions++; throw new Error("source revoked"); } }), /source revoked/);
    assert.equal(assertions, 1); assert.equal(publications, 0); assert.equal(runtime.current(), previous);
  } finally { await runtime.dispose(); }
});
