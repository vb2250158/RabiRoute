import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { AgentRequestStore } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions } from "../agentRequests/endpointDelivery.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { createAgentThreadControlOwner, type AgentThreadControlRoutesContext } from "./agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "./agentThreadControlOperations.js";
import { createAgentDeliveryRecordOperations } from "./agentDeliveryRecords.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-client-manager-")), ledger = path.join(root, "manager.json"), configPath = path.join(root, "config.json");
  const { DeliveryOwner } = await import("../../apps/rabi-agent/lib/delivery-owner.mjs");
  const { createManagerTransport } = await import("../../apps/rabi-agent/lib/manager-client.mjs");
  const persistence = { read: () => fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) : undefined,
    write: (value: unknown) => fs.writeFileSync(ledger, JSON.stringify(value)) };
  let store = new AgentRequestStore(persistence), dispatches = 0, dropAck = false, denyTarget = false, targetChecks = 0, now = 1000, base = "", generation = 1;
  let dispatchAckLost = false, receiptRecoverable = false, targetReceipt: Awaited<ReturnType<EndpointDeliveryOptions["dispatch"]>> | undefined;
  const endpoint = (node: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: "durable-fixture", nodeId: node, instanceId: node,
    agentId: "dsh", provider: "dsh", sessionId: node + "-session", authorizationIncarnation: "fixture-incarnation" });
  const party = (node: string) => ({ endpoint: endpoint(node), agentAdapter: "dsh" as const, agentType: "agent", threadId: node + "-session" });
  const options = (): EndpointDeliveryOptions => ({ store, managerInstanceId: "durable-fixture", resolveSource: () => party("source"), resolveTarget: () => party("target"),
    resolveExecutionOptions: () => ({ cwd: "fixture-workspace" }),
    authorize: (_value, role) => {
      // Initial resolution and reservation guard pass. The fresh pre-dispatch
      // owner proof then fails, exactly the protocol's prepared retry window.
      if (role === "target" && ++targetChecks >= 3 && denyTarget) throw new Error("fixture target temporarily unavailable before send");
    },
    dispatch: async value => {
      dispatches++; targetReceipt = { deliveryId: value.deliveryId, generation: value.generation, endpoint: value.target,
        promptHash: value.promptHash, executionOptionsHash: value.executionOptionsHash, accepted: true, action: "started", transport: "fixture-owner" };
      if (dispatchAckLost) throw new Error("fixture owner accepted but its ACK was lost");
      return targetReceipt;
    }, reconcile: async () => receiptRecoverable ? targetReceipt : undefined });
  const context = { getTrustedRemoteSource: () => ({ nodeId: "source", agentId: "dsh", provider: "dsh", sessionId: "source-session", sessionName: "Source" }),
    agentRequests: store, applyManagedAgentThreadDefaults: (request: unknown) => request,
    agentThreadRequestOptions: () => ({ allowedWorkspaces: [], endpointDelivery: options(), remoteEndpoint: () => endpoint("source") }),
    readEndpointDeliveryOptions: () => options(),
    handleAgentThreadRequest: (request: Parameters<typeof executeEndpointAgentDelivery>[0]) => executeEndpointAgentDelivery(request, options()),
    agentThreadRequestFailureData: (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : "fixture failure" }),
    refreshAgentRequestReminderTimers: () => {}, publishManagerEvent: () => {}, operationalLog: { record: () => {} }, operationalError: () => ({ message: "fixture" })
  } as unknown as AgentThreadControlRoutesContext;
  const registrations: { dispose(): Promise<void> | void }[] = [], servers: http.Server[] = [], responses: unknown[] = [];
  async function listen() {
    const registry = new ManagerPluginRouteRegistry();
    registrations.push(registry.registerOperations("fixture-threads", createAgentThreadControlOperations(createAgentThreadControlOwner(context))));
    registrations.push(registry.registerOperations("fixture-records", createAgentDeliveryRecordOperations({ agentRequests: store })));
    const server = http.createServer((request, response) => {
      const identity = { guid: "fixture-guid", applicationGenerationId: "fixture-generation-" + generation, managerInstanceId: "fixture-runtime-" + generation };
      const url = new URL(request.url!, "http://fixture.invalid");
      const end = response.end;
      response.end = function (...args: Parameters<typeof end>) { responses.push({ path: url.pathname, body: String(args[0]), status: response.statusCode }); return end.apply(response, args); } as typeof end;
      if (url.pathname === "/.well-known/rabiroute-manager" || url.pathname === "/api/lan-agent/self" || url.pathname === "/meta") {
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 0, data: url.pathname === "/meta"
          ? { ...identity, rabiGuid: identity.guid, health: { live: true, requiredReady: true, state: "healthy" } }
          : { ...identity, protocolVersion: 1, nodeId: "source" } })); return;
      }
      // Fixture ingress owns a fixed trusted source, rather than issuing a real
      // LanAgent credential. Headers cannot impersonate a production principal.
      assert.equal(request.headers["x-rabiroute-agent-type"], "dsh");
      assert.equal(request.headers["x-rabiroute-session-id"], "source-session");
      delete request.headers["x-rabiroute-agent-type"]; delete request.headers["x-rabiroute-session-id"];
      markAuthenticatedConnectionRequest(request);
      if (request.method === "POST" && dropAck) {
        const original = response.end;
        response.end = function (...args: Parameters<typeof original>) { dropAck = false; response.destroy(); return response; } as typeof original;
      }
      if (!registry.handle(request, url, response)) response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; return server;
  }
  let server = await listen();
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: base, managerGuid: "fixture-guid", nodeId: "source", nodeCredential: "fixture-only" }));
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "source" }, now: () => now, random: () => 0, sendEvent: () => false,
    client: (agentType: string, sessionId: string) => createManagerTransport({ configPath, config: JSON.parse(fs.readFileSync(configPath, "utf8")), agentType, sessionId,
      timeoutMs: 1000, discover: async () => ({ managerUrl: base, guid: "fixture-guid", generation: "fixture-generation-" + generation, instance: "fixture-runtime-" + generation }) }) });
  t.after(async () => {
    await owner.close(); for (const value of servers) { value.closeAllConnections(); if (value.listening) await new Promise<void>(resolve => value.close(() => resolve())); }
    for (const registration of registrations) await registration.dispose(); fs.rmSync(root, { recursive: true, force: true });
  });
  const submit = (id: string) => owner.submit({ intentId: id, agentType: "dsh", sessionId: "source-session", request: { action: "send", deliveryId: id,
    sourceThreadId: "source-session", sourceAgentType: "agent", threadId: "target-session", agentAdapter: "dsh", responsePolicy: "none", prompt: "Transport fixture only",
    messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "source-session", sessionName: "Source" } } });
  return { owner, submit, responses, store: () => store, dispatches: () => dispatches, dropAck: () => { dropAck = true; }, deny: (value: boolean) => { denyTarget = value; },
    loseDispatchAck: () => { dispatchAckLost = true; }, recoverTargetReceipt: () => { receiptRecoverable = true; },
    advance: () => { now += 10000; }, restart: async () => {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      store = new AgentRequestStore(persistence); context.agentRequests = store; generation++; server = await listen();
    } };
}

test("real caller HTTP recovers a dropped POST ACK across Manager restart and a changed port without another dispatch", async t => {
  const f = await fixture(t); f.dropAck(); f.submit("ack-lost"); await f.owner.flight;
  assert.equal(f.owner.query({ action: "get", intentId: "ack-lost" }).item!.state, "awaiting_confirmation"); assert.equal(f.dispatches(), 1, JSON.stringify(f.responses));
  await f.restart(); f.advance(); await f.owner.tick();
  assert.equal(f.owner.query({ action: "get", intentId: "ack-lost" }).item!.state, "received"); assert.equal(f.dispatches(), 1);
  assert.equal((await f.store().listEndpointDeliveries()).length, 1);
});

test("real dispatching HTTP reconciliation preserves the formal source body and recovers the original owner receipt", async t => {
  const f = await fixture(t); f.loseDispatchAck(); f.submit("dispatching-original"); await f.owner.flight;
  assert.equal((await f.store().listEndpointDeliveries())[0]?.state, "dispatching"); assert.equal(f.dispatches(), 1);
  f.recoverTargetReceipt(); f.advance(); await f.owner.tick();
  assert.equal(f.owner.query({ action: "get", intentId: "dispatching-original" }).item!.state, "received");
  assert.equal(f.dispatches(), 1); assert.equal((await f.store().listEndpointDeliveries())[0]?.state, "committed");
});

test("real prepared reservation resumes the exact caller intent after pre-send target recovery", async t => {
  const f = await fixture(t); f.deny(true); f.submit("prepared-original"); await f.owner.flight;
  assert.equal((await f.store().listEndpointDeliveries())[0]?.state, "prepared", JSON.stringify(f.responses)); assert.equal(f.dispatches(), 0);
  f.deny(false); f.advance(); await f.owner.tick();
  assert.equal(f.owner.query({ action: "get", intentId: "prepared-original" }).item!.state, "received"); assert.equal(f.dispatches(), 1);
  assert.equal((await f.store().listEndpointDeliveries()).length, 1);
});
