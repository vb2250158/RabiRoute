import assert from "node:assert/strict";
import test from "node:test";
import { createPluginTestHarness } from "@rabiroute/plugin-sdk";

test("core operation cleanup failure still starts and joins its upgrade owner", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let operationEntered!: () => void, finishOperation!: () => void;
  const draining = new Promise<void>(resolve => { operationEntered = resolve; });
  const operationGate = new Promise<void>(resolve => { finishOperation = resolve; });
  let stopped = false, settled = false, upgradeStarted = false;
  const failure = new Error("controlled operation retirement failure");
  const host: Record<string, unknown> = {
    managerPluginRoutes: {
      registerUpgrades: () => ({ stopAccepting() { stopped = true; }, async dispose() { upgradeStarted = true; entered(); await blocked; } }),
      registerOperationsAsync: async () => ({ async dispose() { operationEntered(); await operationGate; throw failure; } }),
      registerHttpProxies: () => ({ dispose() {} })
    },
    createLanAgentConnectionOperation: () => ({}),
    createManagerEventOperationDefinition: () => ({}),
    createWebguiStaticOperations: () => ({ resources: [], fallback: {} })
  };
  for (const factory of ["createCorePublicOperations", "createPluginCatalogOperations", "createWebguiAccessOperations", "createResourceCacheOperations",
    "createLanAgentReadOperations", "createLanAgentTerminalOperations", "createLanAgentComputerOperations", "createLanAgentManagementOperations"])
    host[factory] = () => [];
  const harness = createPluginTestHarness({ services: [["host.manager.core@1", host]] });
  const module = await import(new URL("../../plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs", import.meta.url).href);
  await harness.activate(module);
  const disposal = harness.dispose().then(() => { settled = true; throw new Error("cleanup must reject"); }, error => {
    settled = true; assert.equal(error, failure);
  });
  await draining;
  assert.equal(stopped, true);
  assert.equal(upgradeStarted, false, "accepted operations retain the existing transport until their actual drain finishes");
  finishOperation();
  await started;
  assert.equal(stopped, true);
  assert.equal(settled, false);
  release();
  await disposal;
  assert.equal(settled, true);
});
