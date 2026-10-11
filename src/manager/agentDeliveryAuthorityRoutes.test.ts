import { endpointExecutionOptionsHash } from "../agentRequests/executionOptions.js";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRequestStore, agentDeliveryPromptHash, type AgentRequestPersistence } from "../agentRequests/store.js";
import { normalizeAgentRequestEndpoint, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { handleAgentDeliveryAuthority } from "./agentDeliveryAuthorityRoutes.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { createServer } from "node:http";
import type { AgentDeliveryAuthorityContext } from "./agentDeliveryAuthorityRoutes.js";

class Memory implements AgentRequestPersistence {
  value: unknown;
  read() { return this.value; }
  write(value: unknown) { this.value = structuredClone(value); }
}
const endpoint = (id: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: "manager", instanceId: `node-${id}`,
  nodeId: `node-${id}`, agentId: "worker", provider: "dsh", sessionId: `session-${id}`, authorizationIncarnation: "fixture-incarnation" });
const party = (id: string, target = endpoint(id)) => ({ threadId: target.sessionId, agentAdapter: "dsh" as const,
  agentType: "agent", workspace: "workspace", endpoint: target });
const denied = { code: -1, error: "DELIVERY_AUTHORITY_UNAVAILABLE", authorized: false };
async function query(store: AgentRequestStore, delivery: PreparedEndpointDelivery, options: {
  params?: string; request?: IncomingMessage; authorize?: (value: AgentRequestEndpoint) => void;
  context?: Partial<AgentDeliveryAuthorityContext>;
} = {}) {
  const headers = new Map<string, unknown>();
  let status = 0; let body: unknown;
  const response = { setHeader: (name: string, value: unknown) => headers.set(name, value) } as unknown as ServerResponse;
  const request = options.request ?? { method: "GET", headers: {} } as IncomingMessage;
  const url = new URL(`/api/agent/delivery-authority?${options.params ?? new URLSearchParams({ deliveryId: delivery.deliveryId, generation: delivery.generation })}`, "http://localhost");
  assert.equal(await handleAgentDeliveryAuthority(request, url, response, { ...options.context, store, authorize: options.authorize ?? (() => {}),
    jsonResponse: (_response, code, value) => { status = code; body = value; } }), true);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(body).includes(delivery.prompt), false);
  return { status, body };
}
async function success(store: AgentRequestStore, delivery: PreparedEndpointDelivery, options: Parameters<typeof query>[2] = {}) {
  const authorized: AgentRequestEndpoint[] = [];
  const result = await query(store, delivery, { ...options, authorize: value => { authorized.push(value); options.authorize?.(value); } });
  assert.deepEqual(result, { status: 200, body: { code: 0, data: { authorized: true, deliveryId: delivery.deliveryId,
    generation: delivery.generation, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, ledgerManagerInstanceId: delivery.source.managerInstanceId, source: delivery.source, endpoint: delivery.target, preparation: delivery.preparation, state: delivery.state } } });
  assert.deepEqual(authorized, [delivery.source, delivery.target]);
}
async function fixture(onDispatch?: (store: AgentRequestStore, delivery: PreparedEndpointDelivery) => void | Promise<void>, target = endpoint("b")) {
  target = normalizeAgentRequestEndpoint(target)!;
  const persistence = new Memory(); const store = new AgentRequestStore(persistence);
  const options: EndpointDeliveryOptions = { store, managerInstanceId: "manager", resolveSource: () => party("a"),
    resolveTarget: () => party("b", target), resolveExecutionOptions: () => ({ cwd: "workspace" }), authorize: () => {}, reconcile: async () => undefined,
    dispatch: async delivery => { await onDispatch?.(store, delivery); return { deliveryId: delivery.deliveryId, generation: delivery.generation,
      endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true, action: "started", transport: "http" }; } };
  await executeEndpointAgentDelivery({ action: "send", sourceThreadId: "session-a", sourceAgentType: "agent", threadId: target.sessionId,
    agentAdapter: "dsh", responsePolicy: "required", responseInstruction: "Return evidence", prompt: "Private fixture prompt",
    messageSource: { type: "agent", agentAdapter: "dsh", sessionName: "source", sessionId: "session-a" } }, options);
  return { store, persistence, delivery: store.listEndpointDeliveries()[0] };
}

test("dispatching and committed exact reservations authorize without prompt disclosure across restart", async () => {
  const f = await fixture(async (store, delivery) => { assert.equal(delivery.state, "dispatching"); await success(store, delivery); });
  assert.equal(f.delivery.state, "committed");
  await success(new AgentRequestStore(f.persistence), f.delivery);
});

test("public reservation read rechecks admitted authority after async proofs and rejects another ledger", async () => {
  const f = await fixture();
  assert.deepEqual(await query(f.store, f.delivery, { context: { managerInstanceId: "another-manager" } }), { status: 403, body: denied });
  let active = true;
  assert.deepEqual(await query(f.store, f.delivery, { context: {
    assertRequestAuthority: () => { if (!active) throw new Error("original connection revoked"); },
    refreshEndpoints: async identities => {
      assert.deepEqual(identities.source, f.delivery.source);
      assert.equal(Object.isFrozen(identities.source), true);
      await Promise.resolve(); active = false;
    }
  } }), { status: 403, body: denied });
});

test("real HTTP sessionless authenticated Agent reads another owner reservation and loses access after revocation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-public-authority-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "reader-node");
  authority.registerAgentCatalog(credential.token, [{ agentId: "sessionless-reader", provider: "dsh" }]);
  const f = await fixture();
  let originalOwnerAvailable = true;
  const server = createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(403); response.end(JSON.stringify(denied)); return; }
    void handleAgentDeliveryAuthority(request, new URL(request.url!, "http://fixture.invalid"), response, {
      store: f.store, managerInstanceId: "manager", authorize: () => { if (!originalOwnerAvailable) throw new Error('old owner epoch replaced'); },
      jsonResponse: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/agent/delivery-authority?${new URLSearchParams({ deliveryId: f.delivery.deliveryId, generation: f.delivery.generation })}`;
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "sessionless-reader" };
  const response = await fetch(url, { headers }); assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.ledgerManagerInstanceId, "manager");
  assert.deepEqual(data.source, f.delivery.source);
  assert.deepEqual(data.preparation, JSON.parse(JSON.stringify(f.delivery.preparation)));
  assert.equal(JSON.stringify(data).includes(f.delivery.prompt), false);
  f.store.cancel(f.delivery.preparation.requestId!);
  originalOwnerAvailable = false;
  const terminalResponse = await fetch(url, { headers }); assert.equal(terminalResponse.status, 200);
  const terminal = (await terminalResponse.json()).data;
  assert.equal(terminal.authorized, false); assert.equal(terminal.state, 'cancelled');
  assert.deepEqual(terminal.source, f.delivery.source); assert.equal(terminal.promptHash, f.delivery.promptHash);
  assert.equal(f.store.getEndpointDelivery(f.delivery.deliveryId)?.state, 'cancelled');
  authority.setAgentEnabled("reader-node", "sessionless-reader", false);
  assert.equal((await fetch(url, { headers })).status, 403);
});

test("missing, duplicate, oversized or mismatched identity fails closed", async () => {
  const f = await fixture(); const d = f.delivery;
  const valid = new URLSearchParams({ deliveryId: d.deliveryId, generation: d.generation }).toString();
  for (const params of ["", `generation=${d.generation}`, `deliveryId=${d.deliveryId}`, `deliveryId=missing&generation=${d.generation}`,
    `deliveryId=${d.deliveryId}&generation=wrong`, `${valid}&deliveryId=${d.deliveryId}`, `${valid}&generation=${d.generation}`,
    `${valid}&deliveryId=other`, `${valid}&generation=other`, `deliveryId=${"x".repeat(101)}&generation=${d.generation}`,
    `deliveryId=${d.deliveryId}&generation=${"x".repeat(101)}`]) {
    assert.deepEqual(await query(f.store, d, { params }), { status: 403, body: denied });
  }
});

test("prepared reservations and cancellation during authorization deny; original cancellation yields terminal evidence only", async () => {
  const f = await fixture();
  const preparation = f.store.prepare({ source: party("a"), target: party("b"), responsePolicy: "required", responseInstruction: "Return" });
  const prepared: PreparedEndpointDelivery = { deliveryId: preparation.deliveryId, generation: "prepared-generation",
    source: endpoint("a"), target: endpoint("b"), prompt: "fixture prepared", preparation, state: "prepared",
    promptHash: agentDeliveryPromptHash("fixture prepared"), executionOptions: { cwd: "workspace" },
    executionOptionsHash: endpointExecutionOptionsHash({ cwd: "workspace" }) };
  f.store.bindEndpointDelivery(prepared);
  assert.deepEqual(await query(f.store, prepared), { status: 403, body: denied });
  assert.deepEqual(await query(f.store, f.delivery, { authorize: () => { f.store.cancel(f.delivery.preparation.requestId!); } }), { status: 403, body: denied });
  const cancellation = await query(f.store, f.delivery, { authorize: () => { throw new Error('old source epoch is no longer live'); },
    context: { refreshEndpoints: async () => { throw new Error('old execution identity must not be refreshed'); } } });
  assert.equal(cancellation.status, 200);
  assert.equal((cancellation.body as { data: { authorized: boolean; state: string } }).data.authorized, false);
  assert.equal((cancellation.body as { data: { state: string } }).data.state, 'cancelled');
  assert.deepEqual(await query(f.store, f.delivery, { context: { assertRequestAuthority: () => { throw new Error('reader revoked'); } } }), { status: 403, body: denied });
});

test("source or target revocation fails closed without grant disclosure", async () => {
  const f = await fixture();
  for (const endpointToDeny of [f.delivery.source, f.delivery.target]) {
    assert.deepEqual(await query(f.store, f.delivery, { authorize: value => { if (value.sessionId === endpointToDeny.sessionId) throw new Error("revoked"); } }),
      { status: 403, body: denied });
  }
});

for (const change of ["disabled", "agent-ABA", "re-enrolled", "global-ABA"] as const) {
  for (const duringAuthorize of [false, true]) {
    test(`original LAN principal denies ${change}${duringAuthorize ? " during authorization" : " before query"}`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-authority-query-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
      const config = new RabiGlobalConfigStore(root); config.patch({ webguiLan: { enabled: true } });
      const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-b");
      authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "dsh" }]);
      const request = { method: "GET", url: "/api/agent/delivery-authority", headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } } as unknown as IncomingMessage;
      assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
      const f = await fixture(); await success(f.store, f.delivery, { request });
      const revoke = () => {
        if (change === "global-ABA") { config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } }); }
        else if (change === "re-enrolled") { authority.revokeNode("node-b"); authority.enroll(authority.issueBootstrapTicket().ticket, "node-b"); authority.setAgentEnabled("node-b", "worker", true); }
        else { authority.setAgentEnabled("node-b", "worker", false); if (change === "agent-ABA") authority.setAgentEnabled("node-b", "worker", true); }
      };
      if (!duringAuthorize) revoke();
      let invoked = false;
      assert.deepEqual(await query(f.store, f.delivery, { request, authorize: () => { if (duringAuthorize && !invoked) { invoked = true; revoke(); } } }),
        { status: 403, body: denied });
    });
  }
}

test("authenticated sessionless Agent may read public reservation evidence for another exact owner", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-owner-query-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-b");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "dsh" }]);
  for (const target of [{ ...endpoint("b"), nodeId: "other" }, { ...endpoint("b"), agentId: "other" },
    { ...endpoint("b"), kind: "local" as const }]) {
    const request = { method: "GET", url: "/api/agent/delivery-authority", headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } } as unknown as IncomingMessage;
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
    const f = await fixture(undefined, target);
    await success(f.store, f.delivery, { request });
  }
});
