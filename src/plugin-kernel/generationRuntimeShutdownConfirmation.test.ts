import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRuntime } from "./generationRuntime.js";
import { parsePluginManifest } from "./manifest.js";
import { configureTimeouts, readTimeoutOverrides } from "./runtimeTimeouts.js";

function fixture(t: test.TestContext, dispose: () => Promise<void>) {
  const previous = readTimeoutOverrides(), previousEnvironment = process.env.RABIROUTE_TIMEOUT_OVERRIDES;
  configureTimeouts({ ...previous, "plugin.disposal": 10 });
  t.after(() => {
    configureTimeouts(previous);
    if (previousEnvironment === undefined) delete process.env.RABIROUTE_TIMEOUT_OVERRIDES;
    else process.env.RABIROUTE_TIMEOUT_OVERRIDES = previousEnvironment;
  });
  const manifest = parsePluginManifest({ schemaVersion: 2, id: "io.example.shutdown-owner", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: [], configSchema: { type: "object" }, stateSchemaVersion: 1 });
  const runtime = new GenerationRuntime({ host: "manager", executor: { prepare: async () => ({ activate(context) {
    context.effects.add(async () => dispose, "original native owner");
  } }) } });
  const candidate = { instanceId: "manager:original-owner", revision: "original", manifest, config: {},
    entry: { execution: "in_process" as const, path: "fixture-original-native-owner" } };
  return { runtime, candidate };
}

test("shutdown formally confirms an original owner which completed after ordinary timeout but before shutdown began", async t => {
  let release!: () => void, stopped!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const actualStopped = new Promise<void>(resolve => { stopped = resolve; });
  const { runtime, candidate } = fixture(t, async () => { await gate; stopped(); });
  await runtime.switch([candidate]); await runtime.switch([]);
  const original = runtime.current().cleanupDiagnostics;
  assert.equal(original.length, 1);
  assert.equal(original[0].instanceId, candidate.instanceId);
  assert.equal(original[0].message, "Plugin effect disposal timed out: original native owner after 10ms.");
  assert.equal(original[0].lateConfirmed, undefined);
  release(); await actualStopped;
  // Let the real EffectScope completion handlers observe the original disposer.
  await new Promise(resolve => setImmediate(resolve));
  await runtime.shutdown();
  assert.deepEqual(runtime.current().cleanupDiagnostics, original.map(item => ({ ...item, lateConfirmed: true })));
});

test("rejected publication preserves confirmation before pruning the original retired scope", async t => {
  let release!: () => void, stopped!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const actualStopped = new Promise<void>(resolve => { stopped = resolve; });
  const { runtime, candidate } = fixture(t, async () => { await gate; stopped(); });
  t.after(async () => { release(); await runtime.shutdown(); });
  await runtime.switch([candidate]); await runtime.switch([]);
  const original = runtime.current().cleanupDiagnostics;
  const originalGeneration = runtime.current().id;
  assert.equal(original.length, 1); assert.equal(original[0].lateConfirmed, undefined);
  release(); await actualStopped;
  await new Promise<void>(resolve => setImmediate(resolve));
  const failure = new Error("fixture rejects publication after retirement admission");
  await assert.rejects(runtime.switch([candidate], { beforePublish() { throw failure; } }), error => error === failure);
  assert.equal(runtime.current().id, originalGeneration, "Rejected publication must keep the original generation and diagnostic.");
  const confirmed = original.map(item => ({ ...item, lateConfirmed: true }));
  assert.deepEqual(runtime.current().cleanupDiagnostics, confirmed, "Record formal scope completion before discarding its last confirmation reference.");
  await runtime.shutdown();
  assert.deepEqual(runtime.current().cleanupDiagnostics, confirmed);
});

test("shutdown never confirms an original owner whose actual cleanup failed", async t => {
  const failure = new Error("original owned process failed to terminate");
  const { runtime, candidate } = fixture(t, async () => { throw failure; });
  await runtime.switch([candidate]); await runtime.switch([]);
  const original = runtime.current().cleanupDiagnostics;
  assert.equal(original.length, 1); assert.equal(original[0].message, failure.message);
  await assert.rejects(runtime.shutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].cause, failure);
    return true;
  });
  assert.ok(runtime.current().cleanupDiagnostics.length >= original.length);
  assert.ok(runtime.current().cleanupDiagnostics.every(item => item.lateConfirmed === undefined));
});

test("shutdown never confirms an original owner whose completion remains unknown", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { runtime, candidate } = fixture(t, async () => gate);
  try {
    await runtime.switch([candidate]); await runtime.switch([]);
    await assert.rejects(runtime.shutdown({ timeoutMs: 30 }), (error: unknown) => {
      // The scope join may time out just before the outer shutdown timer.
      // Require the actual timeout cause even when shutdown preserves it in an aggregate.
      const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
      assert.ok(failures.length > 0);
      for (const failure of failures) {
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /timed out/);
      }
      return true;
    });
    assert.ok(runtime.current().cleanupDiagnostics.length > 0);
    assert.ok(runtime.current().cleanupDiagnostics.every(item => item.lateConfirmed === undefined));
  } finally { release(); }
});
