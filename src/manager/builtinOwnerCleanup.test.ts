import { canonicalManagerPluginFixture } from "./canonicalManagerPlugin.fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createPluginTestHarness } from "@rabiroute/plugin-sdk";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("performance retirement joins its collector after API and registration failures", async () => {
  const entered = deferred(), release = deferred();
  const operationError = new Error("controlled operation retirement failure");
  const apiError = new Error("controlled API retirement failure");
  const originalHook = () => {};
  let settled = false, collectorStopped = false;
  const host = {
    recordManagerHttpRequest: originalHook,
    managerReadOnly: false, runtimes: new Map(), rabiGlobalConfig: {},
    performanceMonitoring: { recordHttpRequest() {}, createActivation() {
      return { publish() {}, rollback() {}, start() {}, async dispose() {
        entered.resolve(); await release.promise; collectorStopped = true;
      } };
    } },
    PerformanceApi: class { async close() { throw apiError; } },
    createPerformanceOperations: () => [],
    managerPluginRoutes: { registerOperationsAsync: async () => ({ async dispose() { throw operationError; } }) }
  };
  const { module, ports } = await canonicalManagerPluginFixture("performance", host);
  const harness = createPluginTestHarness({ services: [["host.manager.performance@2", ports]] });
  await harness.activate(module);
  const publishedHook = host.recordManagerHttpRequest;
  assert.notEqual(publishedHook, originalHook);
  const disposal = harness.dispose().then(() => { settled = true; throw new Error("cleanup must reject"); }, error => {
    settled = true;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, apiError]);
  });
  await entered.promise;
  assert.equal(settled, false);
  assert.notEqual(host.recordManagerHttpRequest, publishedHook);
  release.resolve();
  await disposal;
  assert.equal(collectorStopped, true);
});

test("persona operation retirement failure still joins and reports storage cleanup", async () => {
  const entered = deferred(), release = deferred(), storageOperations: unknown[] = [];
  const operationError = new Error("controlled storage registration failure");
  const storageError = new Error("controlled storage stop failure");
  let settled = false;
  const host = {
    PersonaStorageOwner: class { async stop() { entered.resolve(); await release.promise; throw storageError; } },
    createPersonaStorageOperations: () => storageOperations,
    managerPluginRoutes: { registerOperationsAsync: async (_instance: unknown, definitions: unknown) => ({ async dispose() {
      if (definitions === storageOperations) throw operationError;
    } }) }
  };
  const { module, ports } = await canonicalManagerPluginFixture("persona", host);
  const harness = createPluginTestHarness({ services: [["host.manager.persona@2", ports]] });
  await harness.activate(module);
  const disposal = harness.dispose().then(() => { settled = true; throw new Error("cleanup must reject"); }, error => {
    settled = true;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, storageError]);
  });
  await entered.promise;
  assert.equal(settled, false);
  release.resolve();
  await disposal;
});
