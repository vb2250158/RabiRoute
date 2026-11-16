import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createGatewayListenerRuntime } from "./gatewayListenerRuntime.js";
import { fixtureApiContract } from "../manager/apiOperationContractFixtures.js";

const definition = { listenerId: "fixture.drain", address: { protocol: "http" as const, hostname: "127.0.0.1", port: 12345 }, protocol: "fixture", invocation: "native" as const,
  authentication: { kind: "none" as const, description: "Original owner." } };
test("all repeated Gateway runtime closes retain the original pending native drain and failure result", async t => {
  const runtime = createGatewayListenerRuntime({ identity: { gatewayId: "fixture", gatewayGenerationId: "fixture", pid: process.pid }, publish() {} });
  const lease = runtime.registerExternalListener("fixture", definition);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  lease.registerOperations([{ contract: fixtureApiContract(), async handler() { entered(); await gate; return { status: 200, body: { ok: true, value: 1 } }; } }]);
  const server = http.createServer((request, response) => lease.handle(request, new URL(request.url!, "http://native"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { release(); await runtime.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}' });
  await started; const first = runtime.dispose(), second = runtime.dispose(); assert.equal(second, first);
  let closed = false; void second.then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); assert.equal((await response).status, 200); await first; assert.equal(runtime.dispose(), first);

  let publishFailure = false;
  const failing = createGatewayListenerRuntime({ identity: { gatewayId: "failure", gatewayGenerationId: "fixture", pid: process.pid }, publish() { if (publishFailure) throw new Error("fixture publish failure"); } });
  failing.registerExternalListener("fixture", definition); publishFailure = true;
  const failed = failing.dispose(); assert.equal(failing.dispose(), failed); await assert.rejects(failed, /cleanup failed/);
  assert.equal(failing.dispose(), failed); await assert.rejects(failing.dispose(), /cleanup failed/);
});

test("Gateway listener address readback follows the original active owner and retirement", async () => {
  const runtime = createGatewayListenerRuntime({ identity: { gatewayId: "dynamic", gatewayGenerationId: "fixture", pid: process.pid }, publish() {} });
  const localName = "webhook.webhook.listener";
  const lease = runtime.registerExternalListener("fixture", { ...definition, listenerId: runtime.operationId(localName) });
  assert.deepEqual(runtime.listenerAddress(localName), definition.address);
  assert.equal(runtime.listenerAddress("missing"), undefined);
  await lease.dispose();
  assert.equal(runtime.listenerAddress(localName), undefined);
  await runtime.dispose();
});

test("matching local listener identities remain distinct across Gateway owners", async () => {
  const make = (gatewayId: string) => createGatewayListenerRuntime({ identity: { gatewayId, gatewayGenerationId: "fixture", pid: process.pid }, publish() {} });
  const first = make("fixture-gateway-a"), second = make("fixture-gateway-b");
  const localName = "gateway.napcat.same-instance.events";
  const firstId = first.operationId(localName), secondId = second.operationId(localName);
  assert.notEqual(firstId, secondId);
  const firstLease = first.registerExternalListener("fixture", { ...definition, listenerId: firstId });
  const secondLease = second.registerExternalListener("fixture", { ...definition, listenerId: secondId });
  try {
    assert.notEqual(firstLease.binding.leaseId, secondLease.binding.leaseId);
    assert.deepEqual(first.listenerAddress(localName), definition.address);
    assert.deepEqual(second.listenerAddress(localName), definition.address);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});
