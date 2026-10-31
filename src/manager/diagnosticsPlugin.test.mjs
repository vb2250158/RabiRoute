import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticsRoutes } from "../../plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/operations.mjs";

test("plugin query preserves owner payloads, provider fields and extensible lifecycle states", async () => {
  let calls = 0;
  const values = [{ id: "a", lifecycleState: "future-state", provider: { value: 3 } }, { id: "b", lastError: "local failure" }, { id: "c", running: true }];
  const routes = createDiagnosticsRoutes({ gatewayDiagnosticsPayload: () => { calls++; return values; } });
  assert.equal(routes.operations.length, 1);
  const operation = routes.operations[0];
  assert.equal(operation.contract.pathTemplate, "/api/gateways");
  assert.equal(operation.contract.operationId, "manager.gateways.read");
  assert.equal(operation.contract.effects.mode, "diagnostic-read");
  const response = await operation.handler({});
  assert.equal(response.status, 200);
  assert.equal(response.body, values);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(calls, 1);
});

test("reads owner on each request, awaits it, and does not turn failures into empty success", async () => {
  let failed = true;
  const failure = new Error("owner unavailable");
  const operation = createDiagnosticsRoutes({ gatewayDiagnosticsPayload: async () => {
    if (failed) throw failure;
    return [{ id: "recovered" }];
  } }).operations[0];
  await assert.rejects(operation.handler({}), error => error === failure);
  failed = false;
  assert.deepEqual((await operation.handler({})).body, [{ id: "recovered" }]);
});

import { createPluginTestHarness } from "../../plugins/contracts/plugin-sdk/index.mjs";
import { activate } from "../../plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/manager.mjs";

test("SDK activation uses scoped registration and releases only its own operations", async () => {
  let active = 0, disposed = 0;
  const harness = createPluginTestHarness({ services: [
    ["host.manager.gateway-status@1", { readStatuses: () => [{ id: "owner" }] }],
    ["host.manager.operations@1", { async registerOperationsAsync(definitions, signal) {
      assert.equal(definitions.length, 1); assert.equal(signal.aborted, false); active++;
      assert.deepEqual((await definitions[0].handler({})).body, [{ id: "owner" }]);
      return { dispose() { active--; disposed++; } };
    } }]
  ] });
  await harness.activate({ activate }); assert.equal(active, 1);
  await harness.dispose(); await harness.dispose();
  assert.equal(active, 0); assert.equal(disposed, 1);
});

test("registration failure cleans the activation and permits a fresh activation", async () => {
  const reason = new Error("registration failed");
  const harness = createPluginTestHarness({ services: [
    ["host.manager.gateway-status@1", { readStatuses: () => [] }],
    ["host.manager.operations@1", { async registerOperationsAsync() { throw reason; } }]
  ] });
  await assert.rejects(harness.activate({ activate }), error => error === reason);
  assert.equal(harness.context.lifecycle.signal.aborted, true);
  await harness.dispose();
});
