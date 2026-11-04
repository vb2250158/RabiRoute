import { endpointExecutionOptionsHash } from "../agentRequests/executionOptions.js";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRequestStore, agentDeliveryPromptHash, type AgentRequestPersistence } from "../agentRequests/store.js";
import { normalizeAgentRequestEndpoint, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { readAgentDeliveryAuthority } from "./agentDeliveryAuthorityRoutes.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { createCorePublicOperations, type CorePublicOperationsContext } from "./corePublicOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
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
  const request = options.request ?? { method: "GET", headers: {} } as IncomingMessage;
  const url = new URL(`/api/agent/delivery-authority?${options.params ?? new URLSearchParams({ deliveryId: delivery.deliveryId, generation: delivery.generation })}`, "http://localhost");
  let captured = false, original: ReturnType<typeof assertTrustedLanAgentPrincipal>;
  const result = await readAgentDeliveryAuthority({ deliveryId: url.searchParams.getAll("deliveryId").length === 1 ? url.searchParams.get("deliveryId") : undefined, generation: url.searchParams.getAll("generation").length === 1 ? url.searchParams.get("generation") : undefined }, { ...options.context, store, authorize: options.authorize ?? (() => {}) }, () => {
    options.context?.assertRequestAuthority?.();
    const current = assertTrustedLanAgentPrincipal(request);
    if (captured && current !== original) throw new Error("Request principal changed.");
    original = current; captured = true;
  });
  assert.equal(result.headers?.["cache-control"], "no-store");
  assert.equal(JSON.stringify(result.body).includes(delivery.prompt), false);
  return { status: result.status, body: result.body };
}
async function success(store: AgentRequestStore, delivery: PreparedEndpointDelivery, options: Parameters<typeof query>[2] = {}) {
  const authorized: AgentRequestEndpoint[] = [];
  const result = await query(store, delivery, { ...options, authorize: value => { authorized.push(value); options.authorize?.(value); } });
  assert.deepEqual(result, { status: 200, body: { code: 0, data: { authorized: true, deliveryId: delivery.deliveryId,
    generation: delivery.generation, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, ledgerManagerInstanceId: delivery.source.managerInstanceId, source: delivery.source, endpoint: delivery.target, preparation: delivery.preparation, state: delivery.state } } });
  assert.deepEqual(authorized, [delivery.target]);
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
  return { store, persistence, delivery: (await store.listEndpointDeliveries())[0] };
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
  const f = await fixture();
  let originalOwnerAvailable = true;
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createCorePublicOperations({ identity: () => ({ applicationGenerationId: "fixture", managerInstanceId: "manager" }), deliveryAuthority: {
    store: f.store, managerInstanceId: "manager", authorize: () => { if (!originalOwnerAvailable) throw new Error("old owner epoch replaced"); }
  } } as unknown as CorePublicOperationsContext).filter(value => value.contract.pathTemplate === "/api/agent/delivery-authority");
  const registration = registry.registerOperations("authority-fixture", definitions);
  t.after(() => registration.dispose());
  const server = createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(403); response.end(JSON.stringify(denied)); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
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
  const accepted = f.store.getEndpointDelivery(f.delivery.deliveryId);
  await f.store.cancel(f.delivery.preparation.requestId!);
  originalOwnerAvailable = false;
  const terminalResponse = await fetch(url, { headers }); assert.equal(terminalResponse.status, 200);
  const terminal = (await terminalResponse.json()).data;
  assert.equal(terminal.authorized, false); assert.equal(terminal.state, 'committed');
  assert.equal(f.store.get(f.delivery.preparation.requestId!)?.status, 'cancelled');
  assert.deepEqual(f.store.getEndpointDelivery(f.delivery.deliveryId), accepted, 'Cancellation retains the accepted state and original receipt.');
  assert.deepEqual(terminal.source, f.delivery.source); assert.equal(terminal.promptHash, f.delivery.promptHash);
  authority.setNodeEnabled("reader-node", false);
  assert.equal(f.store.getEndpointDelivery(f.delivery.deliveryId)?.state, 'committed');
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
  const preparation = await f.store.prepare({ source: party("a"), target: party("b"), responsePolicy: "required", responseInstruction: "Return" });
  const prepared: PreparedEndpointDelivery = { deliveryId: preparation.deliveryId, generation: "prepared-generation",
    source: endpoint("a"), target: endpoint("b"), prompt: "fixture prepared", preparation, state: "prepared",
    promptHash: agentDeliveryPromptHash("fixture prepared"), executionOptions: { cwd: "workspace" },
    executionOptionsHash: endpointExecutionOptionsHash({ cwd: "workspace" }) };
  await f.store.bindEndpointDelivery(prepared);
  assert.deepEqual(await query(f.store, prepared), { status: 403, body: denied });
  assert.deepEqual(await query(f.store, f.delivery, { context: { refreshEndpoints: async () => { await f.store.cancel(f.delivery.preparation.requestId!); } } }), { status: 403, body: denied });
  const cancellation = await query(f.store, f.delivery, { authorize: () => { throw new Error('old source epoch is no longer live'); },
    context: { refreshEndpoints: async () => { throw new Error('old execution identity must not be refreshed'); } } });
  assert.equal(cancellation.status, 200);
  assert.equal((cancellation.body as { data: { authorized: boolean; state: string } }).data.authorized, false);
  assert.equal((cancellation.body as { data: { state: string } }).data.state, 'committed');
  assert.equal(f.store.get(f.delivery.preparation.requestId!)?.status, 'cancelled');
  assert.deepEqual(await f.store.readEndpointDelivery(f.delivery.deliveryId), f.delivery, 'Terminal evidence does not overwrite accepted state or receipt.');
  assert.deepEqual(await query(f.store, f.delivery, { context: { assertRequestAuthority: () => { throw new Error('reader revoked'); } } }), { status: 403, body: denied });
});

test("an unconfirmed cancelled dispatch returns terminal evidence without claiming acceptance", async () => {
  const f = await fixture(async () => { throw new Error("Original dispatch acknowledgement was lost."); });
  assert.equal(f.delivery.state, "dispatching"); assert.equal(f.delivery.receipt, undefined);
  await f.store.cancel(f.delivery.preparation.requestId!);
  const cancelled = f.store.getEndpointDelivery(f.delivery.deliveryId)!;
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.receipt, undefined);
  const cancelledRecord = await f.store.readEndpointDelivery(f.delivery.deliveryId);
  assert.ok(cancelledRecord);
  const result = await query(f.store, cancelledRecord, { authorize: () => { throw new Error("No new target grant"); },
    context: { refreshEndpoints: async () => { throw new Error("Do not refresh a terminal dispatch"); } } });
  assert.equal(result.status, 200);
  assert.equal((result.body as { data: { authorized: boolean; state: string } }).data.authorized, false);
  assert.equal((result.body as { data: { state: string } }).data.state, "cancelled");
  assert.deepEqual(f.store.getEndpointDelivery(f.delivery.deliveryId), cancelled);
});

test("cancelled original request status and accepted evidence survive a file-backed owner restart", async t => {
  const f = await fixture();
  await f.store.cancel(f.delivery.preparation.requestId!);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cancelled-authority-restart-"));
  const statePath = path.join(directory, "requests.json");
  fs.writeFileSync(statePath, JSON.stringify(f.persistence.value));
  const restarted = new AgentRequestStore(statePath);
  t.after(async () => {
    await restarted.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await restarted.ready();
  assert.equal(restarted.get(f.delivery.preparation.requestId!)?.status, "cancelled");
  const readback = await query(restarted, f.delivery, { authorize: () => { throw new Error("No replacement target grant"); } });
  assert.equal(readback.status, 200);
  assert.equal((readback.body as { data: { authorized: boolean; state: string } }).data.authorized, false);
  assert.equal((readback.body as { data: { state: string } }).data.state, "committed");
  const accepted = await restarted.readEndpointDelivery(f.delivery.deliveryId);
  assert.equal(accepted?.state, "committed"); assert.deepEqual(accepted?.receipt, f.delivery.receipt);
  assert.deepEqual(accepted, JSON.parse(JSON.stringify(f.delivery)), "File persistence retains the same JSON record, excluding undefined properties.");
});

test("target revocation fails closed while source attribution is not a second grant", async () => {
  const f = await fixture();
  assert.deepEqual(await query(f.store, f.delivery, { authorize: value => { if (value.sessionId === f.delivery.target.sessionId) throw new Error("revoked"); } }),
    { status: 403, body: denied });
});

for (const change of ["disabled", "node-ABA", "re-enrolled", "global-ABA"] as const) {
  for (const duringAuthorize of [false, true]) {
    test(`original LAN principal denies ${change}${duringAuthorize ? " during authorization" : " before query"}`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-authority-query-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
      const config = new RabiGlobalConfigStore(root); config.patch({ webguiLan: { enabled: true } });
      const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-b");
      const request = { method: "GET", url: "/api/agent/delivery-authority", headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } } as unknown as IncomingMessage;
      assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
      const f = await fixture(); await success(f.store, f.delivery, { request });
      const revoke = () => {
        if (change === "global-ABA") { config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } }); }
        else if (change === "re-enrolled") { authority.revokeNode("node-b"); authority.enroll(authority.issueBootstrapTicket().ticket, "node-b"); }
        else {
      authority.setNodeEnabled("node-b", false);
      if (change === "node-ABA") {
        authority.setNodeEnabled("node-b", true);
        assert.ok(authority.authenticate(credential.token), "Restored node accepts fresh authentication while the original request lease remains revoked.");
      }
    }
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
  for (const target of [{ ...endpoint("b"), nodeId: "other" }, { ...endpoint("b"), agentId: "other" },
    { ...endpoint("b"), kind: "local" as const }]) {
    const request = { method: "GET", url: "/api/agent/delivery-authority", headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } } as unknown as IncomingMessage;
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
    const f = await fixture(undefined, target);
    await success(f.store, f.delivery, { request });
  }
});
