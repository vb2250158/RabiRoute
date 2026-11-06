import { nativeHttpTestFetch } from "../manager/nativeHttpTestClient.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRequestStore, type AgentRequestPersistence } from "./store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type EndpointDeliveryReceipt, type PreparedEndpointDelivery } from "./endpointDelivery.js";
import { executePreparedEndpointDelivery } from "./endpointExecution.js";
import { createDeviceAgentOwner } from "../plugins/io.rabiroute.agent.device-agent/src/agentAdapters/deviceAgentOwner.js";
import { createDeviceAgentOperations } from "../plugins/io.rabiroute.agent.device-agent/src/agentAdapters/deviceAgentOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { assertDeviceAgentPreparedAuthority, assertDeviceAgentPreparedClaimAuthority } from "../manager/deviceAgentPreparedAuthority.js";

class Memory implements AgentRequestPersistence {
  value: unknown;
  read() { return this.value; }
  write(value: unknown) { this.value = structuredClone(value); }
}

test("connection source survives real Device prepared HTTP, native claim and exact receipt without a synthetic source task", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connection-device-transport-"));
  const store = new AgentRequestStore(new Memory());
  const proof = async (id: string) => {
    const delivery = await store.readEndpointDelivery(id); assert.ok(delivery); store.assertEndpointDeliveryActive(id);
    return { authorized: true, state: delivery.state, deliveryId: id, generation: delivery.generation,
      ledgerManagerInstanceId: "manager", source: delivery.source, endpoint: delivery.target,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, preparation: delivery.preparation };
  };
  const owner = createDeviceAgentOwner({ dataDir: directory, ownerInstanceId: "native-owner",
    authorize: request => request.headers.authorization === "device" ? { scope: "scope", sourceDeviceId: "device-one", deviceOwner: true }
      : request.headers.authorization === "manager" ? { scope: "scope", sourceDeviceId: "pc-a", deviceOwner: true } : null,
    authorizeDelivery: async () => ({ scope: "scope" }), assertDeviceAssignment: async (scope, id) => { assert.equal(scope, "scope"); assert.equal(id, "device-one"); },
    authorizePrepared: async (_request, _id, input) => { assertDeviceAgentPreparedAuthority(input, await proof(input.delivery.deliveryId)); return { scope: "scope", ledgerOwnerDeviceId: "pc-a" }; },
    authorizePreparedClaim: async (_request, _id, evidence) => { assertDeviceAgentPreparedClaimAuthority(evidence, await proof(evidence.deliveryId)); }
  });
  const routes = new ManagerPluginRouteRegistry(), registration = routes.registerOperations("connection-device", createDeviceAgentOperations(() => owner));
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/device-agents/device-one";
  async function call(auth: string, method: string, suffix: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await nativeHttpTestFetch(base + suffix, { method, headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json() as { data: Record<string, unknown>; code: unknown };
    assert.ok(response.ok, JSON.stringify(json)); assert.equal(json.code, 0); return { status: response.status, data: json.data };
  }
  try {
    const published = await call("device", "PUT", "/session", { sessionId: "native-task", name: "Native device", loaded: true, capabilities: ["language-model"] });
    const session = published.data.session as { sessionId: string; ownerEpoch: string };
    const sessionProof = await call("manager", "GET", "/session");
    const target = { kind: "device" as const, managerInstanceId: "manager", instanceId: "native-owner", agentId: "device-one", provider: "deviceAgent",
      sessionId: session.sessionId, authorizationIncarnation: sessionProof.data.authorizationIncarnation as string };
    let sends = 0, receipt: EndpointDeliveryReceipt | undefined;
    const options: EndpointDeliveryOptions = { store, managerInstanceId: "manager",
      resolveSource: () => ({ threadId: "", agentType: "agent", connection: { kind: "connection", managerInstanceId: "manager", transport: "lan-agent", id: "real-node", ledgerOwnerDeviceId: "pc-a" } }),
      resolveTarget: () => ({ endpoint: target, threadId: target.sessionId, agentAdapter: "deviceAgent", agentType: "agent" }),
      resolveExecutionOptions: () => ({}), authorize: () => {}, reconcile: async () => receipt,
      dispatch: async delivery => {
        const context = { endpoint: target, assertAuthorized: () => {}, beginAttempt: async () => sends === 0,
          readReceipt: async () => receipt, writeReceipt: async (_d: PreparedEndpointDelivery, value: EndpointDeliveryReceipt) => { receipt = value; },
          send: async (frozen: PreparedEndpointDelivery) => {
            sends++;
            const queued = await call("manager", "POST", "/prepared-deliveries", { ledgerOwnerDeviceId: "pc-a", delivery: frozen });
            assert.equal(queued.data.receipt, null, "HTTP queued is not acceptance");
            const claim = await call("device", "POST", "/deliveries/claim", session);
            const claimed = claim.data.delivery as { deliveryId: string; prompt: string; envelope: { messageSource: { type: string; actorId: string } } };
            assert.equal(claimed.deliveryId, frozen.deliveryId); assert.equal(claimed.prompt, frozen.prompt);
            assert.equal(claimed.envelope.messageSource.type, "system"); assert.equal(claimed.envelope.messageSource.actorId, "real-node");
            const reconciled = await call("manager", "POST", "/prepared-deliveries/reconcile", { ledgerOwnerDeviceId: "pc-a", delivery: frozen });
            const nativeReceipt = reconciled.data.receipt as EndpointDeliveryReceipt;
            assert.equal(nativeReceipt.deliveryId, frozen.deliveryId); assert.deepEqual(nativeReceipt.endpoint, target);
            assert.equal(nativeReceipt.accepted, true); assert.equal(nativeReceipt.transport, "device-mailbox");
            return { threadId: target.sessionId, action: "claimed", transport: "device-mailbox" };
          } };
        return (await executePreparedEndpointDelivery(delivery, context))!;
      } };
    const request = { action: "send" as const, agentAdapter: "deviceAgent" as const, threadId: target.sessionId, prompt: "Execute the actual device task", deliveryId: "caller-key", responsePolicy: "none" as const };
    assert.equal((await executeEndpointAgentDelivery(request, options)).data.status, "delivered");
    assert.equal((await executeEndpointAgentDelivery(request, options)).data.status, "delivered"); assert.equal(sends, 1);
    const stored = (await store.listEndpointDeliveries())[0]!;
    assert.equal(stored.preparation.source.threadId, ""); assert.equal(stored.preparation.source.endpoint, undefined);
    assert.deepEqual(stored.source, stored.preparation.source.connection); assert.equal(stored.receipt?.transport, "device-mailbox");
    const changedSource = { ...stored, source: { ...stored.source, id: "different-node" } } as PreparedEndpointDelivery;
    await assert.rejects(call("manager", "POST", "/prepared-deliveries/reconcile", { ledgerOwnerDeviceId: "pc-a", delivery: changedSource }), /MISMATCH/);
    assert.equal(owner.readSession("scope", "device-one", target.sessionId)?.deliveries.length, 1);
  } finally {
    await store.close(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
