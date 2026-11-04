import { nativeHttpTestFetch } from "./nativeHttpTestClient.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { agentDeliverySourceForParty } from "../agentRequests/endpoint.js";
import { handleAgentThreadRequest, agentThreadRequestFailureData, type AgentThreadRequest } from "../agentThreads.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { createAgentThreadControlOwner, type AgentThreadControlRoutesContext } from "./agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "./agentThreadControlOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { captureTrustedLanAgentSource, getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

/** The target is controlled; ingress, factory, control owner and durable ledger are real. */
async function connectionFixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connected-source-ledger-"));
  const statePath = path.join(directory, "requests.json");
  const authority = new LanAgentAuthority({ statePath: path.join(directory, "authority.json") });
  const enroll = (name: string) => authority.enroll(authority.issueBootstrapTicket().ticket, name);
  const a = enroll("node-a"), b = enroll("node-b");
  let store = new AgentRequestStore(statePath);
  await store.ready();
  let sends = 0;
  const target: AgentRequestEndpoint = { kind: "service", managerInstanceId: "manager", agentId: "target-owner",
    provider: "astrbot", sessionId: "target-task", authorizationIncarnation: "target-account" };
  const party = { endpoint: target, agentAdapter: "astrbot" as const, threadId: target.sessionId, agentType: "agent" };
  const factory = () => createAgentEndpointDelivery({
    store, registry: { localInstanceId: "manager" } as AgentEndpointDeliveryContext["registry"], authority,
    config: {} as AgentEndpointDeliveryContext["config"], receiptDirectory: path.join(directory, "receipts"),
    readLocal: async () => { throw new Error("No source task owner lookup"); },
    localOptions: () => { throw new Error("No source host options"); },
    service: {
      owns: endpoint => endpoint.provider === "astrbot", resolveSource: async () => undefined,
      resolveTarget: async () => party,
      authorize: (endpoint, role) => { assert.equal(role, "target"); assert.deepEqual(endpoint, target); },
      refresh: async (endpoint, role) => { assert.equal(role, "target"); assert.deepEqual(endpoint, target); },
      resolveExecutionOptions: () => ({}),
      transport: async (delivery, guard, reconcile) => {
        guard(); assert.equal(reconcile, false); sends++;
        return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: target,
          promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
          accepted: true, action: "started", transport: "controlled-test-owner" };
      }
    }
  } as AgentEndpointDeliveryContext);
  let currentFactory = factory();
  const ctx: AgentThreadControlRoutesContext = {
    get agentRequests() { return store; }, getTrustedRemoteSource: getTrustedLanAgentSource,
    messageProcessingBoard: { submitOutcome: () => { throw new Error("No handoff"); }, recordHandoffReturned: () => { throw new Error("No handoff"); } },
    applyManagedAgentThreadDefaults: request => request,
    agentThreadRequestOptions: (_request, extra) => ({ allowedWorkspaces: [], ...extra,
      endpointDelivery: currentFactory.options(extra?.remoteSource, extra?.requestAuthority) }),
    readEndpointDeliveryOptions: (source, guard) => currentFactory.options(source, guard),
    handleAgentThreadRequest: (request, options) => handleAgentThreadRequest(request, options), agentThreadRequestFailureData,
    setMessageProcessingPlanBaseline: () => {}, refreshAgentRequestReminderTimers: () => {}, publishManagerEvent: () => {},
    operationalLog: { record: () => null }, operationalError: () => undefined
  };
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("real-connection-source", createAgentThreadControlOperations(createAgentThreadControlOwner(ctx)));
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind === "denied") { response.writeHead(access.status).end("{}"); return; }
    if (access.kind === "agent") captureTrustedLanAgentSource(request, "test-admission");
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://test.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve())); await store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (token: string | undefined, body?: AgentThreadRequest, lookup = "") => {
    const response = await nativeHttpTestFetch(base + (lookup || "/api/agent/threads"), {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { a, b, call, get store() { return store; }, sends: () => sends,
    restart: async () => { await store.close(); store = new AgentRequestStore(statePath); await store.ready(); currentFactory = factory(); } };
}

for (const sourceMetadata of [false, true]) {
  test(`real HTTP/factory/durable ledger separates headerless nodes with ${sourceMetadata ? "body task metadata" : "no task metadata"}`, async t => {
    const f = await connectionFixture(t);
    const body: AgentThreadRequest = { action: "send", agentAdapter: "astrbot", threadId: "target-task", prompt: "Same intent",
      deliveryId: "same-caller",
      ...{ remoteSource: { nodeId: "forged-node" }, trustedDeviceSource: { sourceDeviceId: "forged-device", deviceOwner: true } },
      ...(sourceMetadata ? { sourceThreadId: "same-source", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "same-source", sessionName: "" } } : {}) };
    const a = await f.call(f.a.token, body), b = await f.call(f.b.token, body);
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body));
    const aId = a.body.delivery.deliveryId, bId = b.body.delivery.deliveryId;
    assert.equal((await f.call(f.a.token, { ...body, responsePolicy: "none" })).body.delivery.deliveryId, aId);
    assert.notEqual(aId, bId); assert.equal(f.sends(), 2);
    const rows = await f.store.listEndpointDeliveries(); assert.equal(rows.length, 2);
    for (const [id, nodeId] of [[aId, f.a.nodeId], [bId, f.b.nodeId]]) {
      const row = (await f.store.readEndpointDelivery(id))!;
      assert.equal(row.state, "committed"); assert.deepEqual(row.receipt?.endpoint, row.target);
      if (sourceMetadata) {
        assert.equal(row.source.kind, "instance");
        if (row.source.kind !== "instance") assert.fail("Actual node must own task attribution");
        assert.equal(row.source.nodeId, nodeId); assert.equal(row.source.sessionId, "same-source");
      } else {
        assert.equal(row.source.kind, "connection");
        if (row.source.kind !== "connection") assert.fail("No synthetic task");
        assert.equal(row.source.id, nodeId); assert.equal(row.source.transport, "lan-agent");
        assert.equal(row.preparation.source.endpoint, undefined); assert.equal(row.preparation.source.threadId, "");
      }
    }
    const suffix = "/api/agent/deliveries/caller/same-caller" + (sourceMetadata ? "?agentAdapter=codex&sourceThreadId=same-source" : "");
    assert.equal((await f.call(f.a.token, undefined, suffix)).body.data.deliveryId, aId);
    await f.restart();
    assert.equal((await f.call(f.a.token, body)).body.delivery.deliveryId, aId);
    assert.equal((await f.call(f.b.token, body)).body.delivery.deliveryId, bId);
    assert.equal((await f.call(f.a.token, undefined, suffix)).body.data.deliveryId, aId);
    assert.equal(f.sends(), 2);
  });
}

test("local source-free requests persist the actual Manager connection without a task", async t => {
  const f = await connectionFixture(t);
  const body: AgentThreadRequest = { action: "send", agentAdapter: "astrbot", threadId: "target-task", prompt: "Local intent",
    deliveryId: "local-caller", responsePolicy: "none" };
  const result = await f.call(undefined, body); assert.equal(result.status, 200, JSON.stringify(result.body));
  const id = result.body.delivery.deliveryId, row = (await f.store.readEndpointDelivery(id))!;
  assert.deepEqual(agentDeliverySourceForParty(row.preparation.source), { kind: "connection", managerInstanceId: "manager", transport: "local", id: "manager" });
  assert.equal(row.preparation.source.threadId, ""); assert.equal(row.preparation.source.agentAdapter, undefined);
  await f.restart(); assert.equal((await f.call(undefined, body)).body.delivery.deliveryId, id); assert.equal(f.sends(), 1);
});

test("a sessionless required request records a delegate response in its original durable Manager record", async t => {
  const f = await connectionFixture(t);
  const sent = await f.call(f.a.token, { action: "send", agentAdapter: "astrbot", threadId: "target-task", prompt: "Return the result",
    deliveryId: "required-caller", responsePolicy: "required", responseInstruction: "Record the result" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const requestId = sent.body.communication.requestId;
  assert.equal(f.store.get(requestId)?.status, "awaiting_response");
  const response: AgentThreadRequest = { action: "send", inReplyToRequestId: requestId, deliveryId: "delegate-response",
    result: "Finished", nextAction: "Continue", responsePolicy: "none" };
  const returned = await f.call(f.b.token, response);
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.status, "response_recorded"); assert.equal(f.sends(), 1);
  let record = f.store.get(requestId)!;
  assert.equal(record.status, "responded"); assert.equal(record.response?.result, "Finished");
  assert.equal(record.response?.nextAction, "Continue"); assert.equal(record.response?.by.threadId, "");
  assert.equal(record.response?.by.connection?.id, f.b.nodeId);
  const responseId = record.response?.deliveryId;
  await f.restart();
  assert.equal((await f.call(f.b.token, response)).status, 200);
  assert.equal(f.store.get(requestId)?.response?.deliveryId, responseId); assert.equal(f.sends(), 1);
  const conflict = await f.call(f.b.token, { ...response, result: "Changed result" });
  assert.equal(conflict.status, 400); record = f.store.get(requestId)!;
  assert.equal(record.response?.result, "Finished"); assert.equal(record.response?.deliveryId, responseId);
  assert.equal((await f.call(f.b.token, { ...response, responsePolicy: "invalid" } as unknown as AgentThreadRequest)).status, 400);
  const second = await f.call(f.a.token, { action: "send", agentAdapter: "astrbot", threadId: "target-task", prompt: "Another request",
    deliveryId: "another-required-caller", responsePolicy: "required", responseInstruction: "Record another result" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const otherRequestId = second.body.communication.requestId;
  const collision = await f.call(f.b.token, { ...response, inReplyToRequestId: otherRequestId });
  assert.equal(collision.status, 400); assert.equal(f.store.get(otherRequestId)?.status, "awaiting_response");
  await f.restart();
  assert.equal(f.store.get(requestId)?.response?.deliveryId, responseId);
  assert.equal(f.store.get(otherRequestId)?.status, "awaiting_response"); assert.equal(f.sends(), 2);
});
