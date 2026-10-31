import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { AgentRequestStore } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { sourceScopedAgentDeliveryId, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { listAgentDeliveryRecords, readAgentDeliveryRecord, readDeliveryRecords, createAgentDeliveryRecordOperations } from "./agentDeliveryRecords.js";
import { createAgentThreadControlOwner, type AgentThreadControlRoutesContext } from "./agentThreadControlRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

function fixture() {
  let persisted: unknown, writes = 0, fail = false;
  const persistence = { read: () => persisted, write: (value: unknown) => { if (fail) throw new Error("disk unavailable"); persisted = structuredClone(value); writes++; } };
  const store = new AgentRequestStore(persistence);
  const endpoint = (id: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: "manager", instanceId: id, nodeId: id,
    agentId: "dsh", provider: "dsh", sessionId: id + "-session", authorizationIncarnation: "incarnation" });
  const party = (id: string) => ({ endpoint: endpoint(id), agentAdapter: "dsh" as const, agentType: "agent", threadId: id + "-session" });
  const options: EndpointDeliveryOptions = { store, managerInstanceId: "manager", resolveSource: () => party("source"), resolveTarget: () => party("target"),
    resolveExecutionOptions: () => ({ cwd: "fixture-workspace" }), authorize: () => {},
    dispatch: async value => ({ deliveryId: value.deliveryId, generation: value.generation, endpoint: value.target,
      promptHash: value.promptHash, executionOptionsHash: value.executionOptionsHash, accepted: true, action: "started", transport: "fixture" }),
    reconcile: async () => undefined };
  const send = (deliveryId: string, extra: Partial<EndpointDeliveryOptions> = {}) => executeEndpointAgentDelivery({ action: "send", deliveryId,
    sourceThreadId: "source-session", sourceAgentType: "agent", threadId: "target-session", agentAdapter: "dsh", responsePolicy: "none", prompt: "private fixture content",
    messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "source-session", sessionName: "Source" } }, { ...options, ...extra });
  return { store, persistence, options, endpoint, send, writes: () => writes, fail: (value: boolean) => { fail = value; } };
}

test("delivery records show target receipts, retain missing legacy metadata, and exclude private content", async () => {
  const f = fixture(); await f.send("intent-first"); await f.send("intent-second");
  const writes = f.writes(), url = new URL("http://fixture.invalid/api/agent/deliveries?limit=1");
  const first = listAgentDeliveryRecords(f.store, url);
  assert.equal(first.records.length, 1); assert.equal(first.records[0].state, "received");
  assert.equal(first.records[0].attemptCount, 1); assert.ok(first.nextCursor);
  assert.equal(first.records[0].targetAcceptedAt, undefined, "Manager update time is not native target acceptance time");
  assert.equal(first.coverage.includesDisconnectedNodeQueues, false);
  const bytes = JSON.stringify(first); assert.ok(!bytes.includes("private fixture content")); assert.ok(!bytes.includes("authorizationIncarnation"));
  const next = listAgentDeliveryRecords(f.store, new URL(url + "&cursor=" + first.nextCursor));
  assert.equal(next.records.length, 1); assert.notEqual(next.records[0].id, first.records[0].id);
  assert.equal(f.writes(), writes);
  const raw = structuredClone(f.persistence.read()) as { deliveries: Record<string, { createdAt?: string; updatedAt?: string; attemptCount?: number }> };
  const legacy = raw.deliveries[first.records[0].id]; delete legacy.createdAt; delete legacy.updatedAt; delete legacy.attemptCount;
  const oldStore = new AgentRequestStore({ read: () => raw, write: () => { throw new Error("Read must not persist"); } });
  assert.equal(readAgentDeliveryRecord(oldStore, first.records[0].id)?.attemptCount, undefined);
});

test("failed persistence rolls metadata back, while unknown dispatch remains pending rather than received", async () => {
  const f = fixture(); await f.send("intent-unknown", { dispatch: async () => { throw new Error("ACK unavailable"); } });
  const original = (await f.store.listEndpointDeliveries())[0];
  assert.equal(readAgentDeliveryRecord(f.store, original.deliveryId)?.state, "awaiting_confirmation");
  assert.match(readAgentDeliveryRecord(f.store, original.deliveryId)?.reason ?? "", /ACK unavailable/);
  f.fail(true);
  await assert.rejects(f.store.noteEndpointDeliveryFailure(original.deliveryId, new Error("must roll back")), /disk unavailable/);
  assert.deepEqual(await f.store.readEndpointDelivery(original.deliveryId), original);
});

test("offline node queue is explicitly unobservable and never represented by an empty successful page", async () => {
  const f = fixture(); const url = new URL("http://fixture.invalid/api/agent/deliveries?nodeId=offline");
  const response = await readDeliveryRecords({ agentRequests: f.store }, url);
  assert.equal(response.status, 503); assert.equal((response.body as any).errorCode, "DELIVERY_NODE_UNAVAILABLE");
  const filtered = await readDeliveryRecords({ agentRequests: f.store }, new URL("http://fixture.invalid/api/agent/deliveries?limit=201"));
  assert.equal(filtered.status, 400);
});

test("executable delivery list/detail contracts serve the original store without writes", async t => {
  const f = fixture(); await f.send("intent-http"); const before = f.writes();
  const registry = new ManagerPluginRouteRegistry(); const registration = registry.registerOperations("delivery-fixture", createAgentDeliveryRecordOperations({ agentRequests: f.store }));
  const server = http.createServer((request, response) => { if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/deliveries`;
  const list = await fetch(base); assert.equal(list.status, 200); const page = await list.json() as any;
  const detail = await fetch(base + "/" + page.data.records[0].id); assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as any).data.receipt.accepted, true); assert.equal(f.writes(), before);
});

test("caller lookup proves absence only for the exact source and retains dispatching or corrupt reservations", async () => {
  const f = fixture(); const remote = { nodeId: "source", agentId: "dsh", provider: "dsh" as const, sessionId: "source-session", sessionName: "Source" };
  const context = { agentRequests: f.store, getTrustedRemoteSource: () => remote,
    readEndpointDeliveryOptions: () => f.options } as unknown as AgentThreadControlRoutesContext;
  const read = () => createAgentThreadControlOwner(context).prepare(new http.IncomingMessage(new Socket())).lookupCallerDelivery("intent-original");
  const absent = await read(); assert.equal(absent.status, 404); assert.equal(absent.body.errorCode, "DELIVERY_NOT_RESERVED");
  await f.send("intent-original", { dispatch: async () => { throw new Error("connection closed after send"); } });
  const pending = await read(); assert.equal(pending.status, 200); assert.equal((pending.body.data as any).state, "dispatching"); assert.equal((pending.body.data as any).canSubmitSameIntent, false);
  const original = (await f.store.listEndpointDeliveries())[0];
  const receipt: EndpointDeliveryReceipt = { deliveryId: original.deliveryId, generation: original.generation, promptHash: original.promptHash,
    executionOptionsHash: original.executionOptionsHash, endpoint: original.target, accepted: true, action: "receipt_recovered", transport: "fixture" };
  await f.store.commitEndpointReceipt(original.deliveryId, receipt);
  const committed = await read(); assert.equal((committed.body.data as any).receipt.accepted, true);
  const broken = structuredClone(f.persistence.read()) as any; broken.deliveries[original.deliveryId].prompt = "corrupted";
  context.agentRequests = new AgentRequestStore({ read: () => broken, write: () => {} });
  const unknown = await read(); assert.equal(unknown.status, 409); assert.equal(unknown.body.canSubmitSameIntent, false);
  assert.equal(readAgentDeliveryRecord(context.agentRequests, original.deliveryId)?.state, "blocked");
});

test("changing an authorization incarnation cannot turn an old reserved caller ID into safe absence", async () => {
  const f = fixture(); await f.send("intent-incarnation");
  const current = { ...f.endpoint("source"), authorizationIncarnation: "new-incarnation" };
  const options = { ...f.options, authorize: (endpoint: AgentRequestEndpoint) => {
    if (endpoint.nodeId === "source" && endpoint.authorizationIncarnation !== current.authorizationIncarnation) throw new Error("Original source incarnation was revoked");
  } };
  const context = { agentRequests: f.store,
    getTrustedRemoteSource: () => ({ nodeId: "source", agentId: "dsh", provider: "dsh", sessionId: "source-session", sessionName: "Source" }),
    readEndpointDeliveryOptions: () => ({ ...options, resolveSource: () => ({ endpoint: current, threadId: current.sessionId, agentType: "agent" }) }) } as unknown as AgentThreadControlRoutesContext;
  const owner = createAgentThreadControlOwner(context).prepare(new http.IncomingMessage(new Socket()));
  await assert.rejects(owner.lookupCallerDelivery("intent-incarnation"), /Original source incarnation was revoked/);
});

test("an unreadable original owner cannot prove caller absence or appear as an empty successful GUI page", async () => {
  const f = fixture();
  const store = new AgentRequestStore({ read: () => { throw new Error("fixture read failed"); }, write: () => { throw new Error("must not overwrite"); } });
  const context = { agentRequests: store, readEndpointDeliveryOptions: () => f.options } as unknown as AgentThreadControlRoutesContext;
  const result = await createAgentThreadControlOwner(context).prepare(new http.IncomingMessage(new Socket()))
    .lookupCallerDelivery("original-intent", { sourceThreadId: "source-session", sourceAgentType: "agent" });
  assert.equal(result.status, 503); assert.equal(result.body.canSubmitSameIntent, false);
  const page = await readDeliveryRecords({ agentRequests: store }, new URL("http://fixture.invalid/api/agent/deliveries"));
  assert.equal(page.status, 503); assert.equal((page.body as any).errorCode, "DELIVERY_EVIDENCE_UNAVAILABLE");
});

test("the actual thread plugin caller API uses the factory read authority and the explicit guarded session", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caller-authority-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AgentRequestStore({ read: () => undefined, write: () => {} });
  let sent = 0, readAuthorityCalls = 0;
  const factory = createAgentEndpointDelivery({ store, receiptDirectory: directory,
    authority: { getNodeAuthorization: () => ({ incarnation: "lease" }) },
    config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "policy" }) },
    registry: { localInstanceId: "manager", listNodes: () => [{ nodeId: "source", connected: true }, { nodeId: "target", connected: true }],
      getInstanceAgent: () => ({ provider: "dsh", name: "Fixture task", workspace: directory }),
      manageAgent: async (_node: string, _operation: string, parameters: any) => {
        sent++; const value = parameters.delivery;
        return { deliveryId: value.deliveryId, generation: value.generation, promptHash: value.promptHash,
          executionOptionsHash: value.executionOptionsHash, endpoint: value.target, accepted: true, action: "started", transport: "fixture" };
      } }, localOptions: () => ({ allowedWorkspaces: [] }), readLocal: async () => { throw new Error("No local source substitution"); }
  } as unknown as AgentEndpointDeliveryContext);
  const source = { nodeId: "source", agentId: "dsh", provider: "dsh" as const, sessionId: "source-session", sessionName: "Source" };
  await executeEndpointAgentDelivery({ action: "send", deliveryId: "original-plugin-intent", sourceThreadId: source.sessionId,
    sourceAgentType: "agent", messageSource: { type: "agent", agentAdapter: "dsh", sessionId: source.sessionId, sessionName: "Source" },
    agentAdapter: "dsh", threadId: "target-session", instanceBinding: { instanceId: "target", agentId: "dsh" },
    prompt: "Generic fixture", responsePolicy: "none" }, factory.options(source, () => {}));
  assert.equal(sent, 1);
  const registry = new ManagerPluginRouteRegistry(), starters: Array<() => Promise<() => Promise<void>>> = [];
  const runtime = { agentRequests: store, createAgentThreadControlOwner,
    createAgentThreadControlOperations: (await import("./agentThreadControlOperations.js")).createAgentThreadControlOperations,
    getTrustedLanAgentSource: () => ({ ...source, sessionId: "stale-saved-session" }),
    readEndpointDeliveryOptions: (...args: Parameters<typeof factory.options>) => { readAuthorityCalls++; return factory.options(...args); },
    managerPluginRoutes: registry };
  const pluginUrl = new URL("../../plugins/builtin/io.rabiroute.manager.agent-thread-control/1.0.0/manager.mjs", import.meta.url);
  const { activate } = await import(pluginUrl.href);
  await activate({ identity: { instanceId: "thread-fixture" }, lifecycle: { signal: new AbortController().signal }, services: { require: () => runtime, provide: () => {} },
    contributions: { register: () => {} }, effects: { add: (starter: () => Promise<() => Promise<void>>) => starters.push(starter) } });
  const disposers = await Promise.all(starters.map(start => start()));
  const server = http.createServer((request, response) => {
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority("/api/agent/threads", body, { provider: "dsh", sessionId: source.sessionId }));
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await Promise.all(disposers.map(dispose => dispose())); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/deliveries/caller/original-plugin-intent`;
  const original = await fetch(base + "?sourceThreadId=source-session&sourceAgentType=agent&agentAdapter=dsh");
  assert.equal(original.status, 200); assert.equal(((await original.json()) as any).data.state, "committed");
  assert.equal(readAuthorityCalls, 1); assert.equal(sent, 1);
  const mismatch = await fetch(base + "?sourceThreadId=wrong-session&sourceAgentType=agent&agentAdapter=dsh");
  assert.equal(mismatch.status, 400); assert.notEqual(((await mismatch.json()) as any).canSubmitSameIntent, true);
  assert.equal(sent, 1);
});


test("caller receipt lookup keeps the legacy alias key and refuses ambiguous original receipts", async () => {
  const f = fixture(); await f.send("legacy-intent");
  const original = (await f.store.listEndpointDeliveries())[0]!;
  const oldId = sourceScopedAgentDeliveryId(original.source, "legacy-intent", true);
  const saved = structuredClone(f.persistence.read()) as any;
  const historical = saved.deliveries[original.deliveryId];
  delete saved.deliveries[original.deliveryId];
  historical.deliveryId = historical.preparation.deliveryId = historical.receipt.deliveryId = oldId;
  saved.deliveries[oldId] = historical;
  if (historical.preparation.requestId) saved.requests[historical.preparation.requestId].deliveryId = oldId;
  const store = new AgentRequestStore({ read: () => saved, write: () => { throw new Error("Read must not write"); } });
  const source = { ...f.endpoint("source"), agentId: "renamed-alias" };
  const context = { agentRequests: store, readEndpointDeliveryOptions: () => ({ ...f.options, store,
    resolveSource: () => ({ endpoint: source, threadId: source.sessionId, agentType: "agent" }) }) } as unknown as AgentThreadControlRoutesContext;
  const lookup = () => createAgentThreadControlOwner(context).prepare(new http.IncomingMessage(new Socket()))
    .lookupCallerDelivery("legacy-intent", { sourceThreadId: "source-session", sourceAgentType: "agent" });
  const found = await lookup(); assert.equal(found.status, 200);
  assert.equal((found.body.data as any).deliveryId, oldId);
  assert.equal((found.body.data as any).receipt.deliveryId, oldId);
  assert.equal((found.body.data as any).canSubmitSameIntent, false);
  saved.deliveries[original.deliveryId] = original;
  context.agentRequests = new AgentRequestStore({ read: () => saved, write: () => { throw new Error("Read must not write"); } });
  const conflict = await lookup(); assert.equal(conflict.status, 409); assert.equal(conflict.body.canSubmitSameIntent, false);
});
