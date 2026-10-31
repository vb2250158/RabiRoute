import assert from "node:assert/strict";
import http from "node:http";
import { nativeHttpTestFetch as fetch } from "./nativeHttpTestClient.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCorePublicOperations, type CorePublicOperationsContext } from "./corePublicOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { HostInstanceIdentityReset } from "./identityResetRoutes.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery } from "../agentRequests/endpointDelivery.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";

const guid = "647f6388-a4dc-4327-ab17-3ccbd43ef9e2", operationId = "4dc1ac0f-12eb-4f71-9cd1-eac946a8b93f";
const resetPath = "/api/rabi/identity/reset-instance-id";
async function withHandlerEntry<T>(entered: Promise<void>, pending: Promise<T>, release: () => void, work: () => Promise<void>, localDeadlineMs = 2000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      entered,
      pending.then(reply => {
        const status = typeof reply === "number" ? reply : (reply as { status?: unknown } | null)?.status;
        throw new Error(`Fixture HTTP request completed before handler entry: status=${String(status)}.`);
      }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Fixture handler entry exceeded its ${localDeadlineMs}ms local deadline.`)), localDeadlineMs); })
    ]);
    await work();
  } finally {
    clearTimeout(timer);
    try { release(); }
    finally { await pending.catch(() => undefined); }
  }
}

test("handler-entry waits fail on an early HTTP 500 and still release and join their original request", async () => {
  let released = 0, joined = 0;
  const pending = Promise.resolve({ status: 500 }).then(value => { joined++; return value; });
  await assert.rejects(withHandlerEntry(new Promise<void>(() => {}), pending, () => { released++; }, async () => {
    assert.fail("An early response must not pass handler-entry admission.");
  }), /before handler entry: status=500/);
  assert.equal(released, 1); assert.equal(joined, 1);
});

test("handler-entry deadline cancels and joins a request which never enters or responds", async () => {
  const abort = new AbortController(); let cancelled = 0, joined = 0;
  const pending = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => {
    cancelled++; reject(new Error("Original fixture request cancelled."));
  }, { once: true })).catch(error => { joined++; throw error; });
  await assert.rejects(withHandlerEntry(new Promise<void>(() => {}), pending, () => abort.abort(), async () => {
    assert.fail("An absent handler cannot enter the test body.");
  }, 5), /local deadline/);
  assert.equal(cancelled, 1); assert.equal(joined, 1);
});
async function fixture(t: test.TestContext, overrides: Partial<CorePublicOperationsContext> = {}, nonLan = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-operation-fixture-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "core-node");
  let hostCalls = 0, connectionEnabled = true;
  const host = new HostInstanceIdentityReset({ stateRoot: root, applicationGenerationId: "controlled-generation",
    environment: { RABIROUTE_HOSTED: "1", RABIROUTE_HOST_EXECUTABLE: process.execPath }, execute: async () => { hostCalls++; return { ok: true, state: "queued", operationId }; } });
  let webState = "ready";
  const sourceRecord = { operationId: "source-op", moduleId: "fixture", state: "committed" as const, commitState: "committed" as const, createdAt: "2026-01-01T00:00:00Z", fingerprint: "private-fingerprint", proof: { private: true } };
  const managerIdentity = { applicationGenerationId: "fixture", managerInstanceId: "manager" };
  const context: CorePublicOperationsContext = {
    identity: () => managerIdentity,
    health: () => ({ protocolVersion: 1, applicationGenerationId: "fixture", health: { live: true, requiredReady: true, state: "healthy" }, pluginReadiness: {}, routeLifecycle: {}, backgroundLifecycle: {} }), automaticUpdates: () => ({ state: "disabled", reason: "No external source root is configured." }),
    sourcePatches: { status: () => ({ state: "ready", queued: 0, modules: [] }), operation: async id => {
      return id === "missing" ? undefined : sourceRecord as any;
    } },
    webPatches: { status: () => ({ state: webState, queued: 0, activeReads: 0, identity: { applicationGenerationId: "fixture", managerInstanceId: "manager", pluginGenerationId: "plugin" }, limits: { candidateBytes: 134217728, operations: 2048, candidates: 64 } }) as any, operation: id => id === "committed" ? { operationId: id, state: "committed", revision: 1, active: "a", previous: "b", fingerprint: "native" } : undefined },
    deliveryAuthority: { store: new AgentRequestStore({ read: () => undefined, write: () => {} }), authorize: () => {} },
    identityReset: { service: host, currentGuid: () => guid.toUpperCase() }, ...overrides
  };
  const registry = new ManagerPluginRouteRegistry(), definitions = createCorePublicOperations(context), registration = registry.registerOperations("core-fixture", definitions);
  const server = http.createServer((request, response) => {
    if (!nonLan && evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    if (nonLan) Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.25", configurable: true });
    markAuthenticatedConnectionRequest(request, () => { if (!connectionEnabled) throw new Error("Original fixture connection revoked."); assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const headers: Record<string, string> = nonLan ? { "content-type": "application/json" } : { authorization: "Bearer " + credential.token, "content-type": "application/json" };
  const send = async (tail: string, method = "GET", body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(base + tail, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  return { root, base, headers, send, definitions, registration, authority, credential, context, managerIdentity, revokeConnection: () => { connectionEnabled = false; }, hostCalls: () => hostCalls, blockWeb: () => { webState = "blocked"; } };
}

test("all nine original method/path contracts execute for an enrolled remote connection", async t => {
  const f = await fixture(t); assert.equal(f.definitions.length, 9);
  assert.equal(new Set(f.definitions.map(x => x.contract.method + " " + x.contract.pathTemplate)).size, 9);
  for (const tail of ["/health", "/api/automatic-updates", "/api/source-patches", "/api/web-patches"]) {
    const reply = await f.send(tail); assert.equal(reply.status, 200, tail); assert.equal(reply.headers.get("cache-control"), "no-store");
  }
  assert.equal((await f.send("/api/automatic-updates")).body.data.state, "disabled");
  const source = await f.send("/api/source-patches/operations/source-op"); assert.equal(source.status, 200);
  assert.equal(JSON.stringify(source.body).includes("private"), false); assert.equal(source.body.data.fingerprint, undefined);
  assert.equal((await f.send("/api/web-patches/operations/committed")).body.operationState, "committed");
  assert.equal((await f.send("/api/agent/delivery-authority?deliveryId=absent&generation=g")).status, 403);
  assert.equal((await f.send(resetPath + "/" + operationId)).status, 404);
  const queued = await f.send(resetPath, "POST", { operationId, expectedGuid: guid, confirmed: true }); assert.equal(queued.status, 202, JSON.stringify(queued.body)); assert.equal(queued.body.data.state, "queued"); assert.equal(f.hostCalls(), 1);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "data/rabilink/identity-reset-requests", operationId + ".json"), "utf8"));
  assert.equal(saved.expectedGuid, guid.toUpperCase());
});

test("source missing and native Web blocked/missing receipt meanings remain distinct", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("/api/source-patches/operations/missing")).status, 404);
  const missing = await f.send("/api/web-patches/operations/missing"); assert.equal(missing.status, 404); assert.equal(missing.body.operationState, "not_started");
  f.blockWeb(); const blocked = await f.send("/api/web-patches/operations/missing"); assert.equal(blocked.status, 503); assert.equal(blocked.body.operationState, "unknown");
});

test("reset CAS, strict JSON budget and stable operation ID prevent another Host command", async t => {
  const f = await fixture(t), body = { operationId, expectedGuid: guid, confirmed: true };
  const conflict = await f.send(resetPath, "POST", { ...body, expectedGuid: operationId }); assert.equal(conflict.status, 409, JSON.stringify(conflict.body)); assert.equal(f.hostCalls(), 0);
  assert.equal((await f.send(resetPath, "POST", { ...body, extra: "x" })).status, 400);
  assert.equal((await f.send(resetPath, "POST", { ...body, extra: "x".repeat(3000) })).status, 413);
  assert.equal((await f.send(resetPath + "?unexpected=1", "POST", body)).status, 400);
  assert.equal((await f.send(resetPath, "POST", body)).status, 202);
  assert.equal((await f.send(resetPath, "POST", body)).status, 409); assert.equal(f.hostCalls(), 1);
});

test("disconnect and retirement retain the source owner lease until actual read completion", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { sourcePatches: { status: () => ({}) as any, operation: async () => { entered(); await gate; return undefined; } } });
  const abort = new AbortController(), pending = f.send("/api/source-patches/operations/pending", "GET", undefined, abort.signal).catch(() => null);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  abort.abort(); await pending;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  release(); await retirement; assert.equal(retired, true);
  });
});

test("reset accepted Host command is joined after cancellation; result never starts another command", async t => {
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { identityReset: { currentGuid: () => guid, service: { available: () => true, status: async () => undefined,
    enqueue: async () => { calls++; entered(); await gate; return { operationId, state: "queued" }; } } } });
  const abort = new AbortController(), pending = f.send(resetPath, "POST", { operationId, expectedGuid: guid, confirmed: true }, abort.signal).catch(() => null);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  abort.abort(); await pending;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  release(); await retirement; assert.equal(calls, 1);
  });
});

test("revocation during source await prevents native operation disclosure", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { sourcePatches: { status: () => ({}) as any, operation: async () => { entered(); await gate; return { private: "must-not-disclose" } as any; } } });
  const abort = new AbortController(), pending = f.send("/api/source-patches/operations/pending", "GET", undefined, abort.signal);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  f.authority.setNodeEnabled(f.credential.nodeId, false); release();
  const reply = await pending; assert.equal(reply.status, 403); assert.equal(JSON.stringify(reply.body).includes("must-not-disclose"), false);
  });
});

for (const nonLan of [false, true]) test(`registered ${nonLan ? "non-Lan" : "Lan"} reservation proof retains native source/target and terminal identity`, async t => {
  let saved: unknown;
  const store = new AgentRequestStore({ read: () => saved, write: value => { saved = structuredClone(value); } });
  const endpoint = (id: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: "manager", instanceId: "node-" + id,
    nodeId: "node-" + id, agentId: "worker", provider: "dsh", sessionId: "session-" + id, authorizationIncarnation: "fixture-incarnation" });
  const party = (id: string) => ({ threadId: "session-" + id, agentAdapter: "dsh" as const, agentType: "agent", workspace: "workspace", endpoint: endpoint(id) });
  await executeEndpointAgentDelivery({ action: "send", sourceThreadId: "session-a", sourceAgentType: "agent", threadId: "session-b", agentAdapter: "dsh",
    responsePolicy: "required", responseInstruction: "Return evidence", prompt: "Private fixture prompt", messageSource: { type: "agent", agentAdapter: "dsh", sessionName: "source", sessionId: "session-a" } }, {
    store, managerInstanceId: "manager", resolveSource: () => party("a"), resolveTarget: () => party("b"), resolveExecutionOptions: () => ({ cwd: "workspace" }), authorize: () => {}, reconcile: async () => undefined,
    dispatch: async delivery => ({ deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash,
      executionOptionsHash: delivery.executionOptionsHash, accepted: true, action: "started", transport: "http" })
  });
  const delivery = (await store.listEndpointDeliveries())[0]!; let refreshes = 0;
  const f = await fixture(t, { deliveryAuthority: { store, managerInstanceId: "manager", authorize: () => {}, refreshEndpoints: async identities => {
    refreshes++; assert.equal(Object.isFrozen(identities.source), true); assert.deepEqual(identities.target, delivery.target);
  } } }, nonLan);
  const tail = "/api/agent/delivery-authority?" + new URLSearchParams({ deliveryId: delivery.deliveryId, generation: delivery.generation });
  const active = await f.send(tail); assert.equal(active.status, 200, JSON.stringify(active.body)); assert.equal(active.body.data.authorized, true); assert.equal(refreshes, 1);
  assert.equal(JSON.stringify(active.body).includes(delivery.prompt), false);
  await store.cancel(delivery.preparation.requestId!);
  const terminal = await f.send(tail); assert.equal(terminal.status, 200); assert.equal(terminal.body.data.authorized, false); assert.equal(refreshes, 1);
  assert.equal(terminal.body.data.promptHash, delivery.promptHash); assert.deepEqual(terminal.body.data.source, delivery.source);
  assert.equal((await f.send(tail + "&generation=other")).status, 400);
});

test("reset captures authorization before body, and rejects disable/re-enable ABA before dispatch", async t => {
  let admitted!: () => void, calls = 0;
  const prepared = new Promise<void>(resolve => { admitted = resolve; });
  const f = await fixture(t, { identityReset: { currentGuid: () => guid, service: { available: () => { admitted(); return true; }, status: async () => undefined,
    enqueue: async () => { calls++; return { operationId, state: "queued" }; } } } });
  const payload = JSON.stringify({ operationId, expectedGuid: guid, confirmed: true });
  let wire!: http.ClientRequest;
  const reply = new Promise<number>((resolve, reject) => {
    wire = http.request(f.base + resetPath, { method: "POST", headers: { ...f.headers, "content-length": Buffer.byteLength(payload) } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    wire.once("error", reject); wire.write(payload.slice(0, 10));
  });
  await withHandlerEntry(prepared, reply, () => { if (!wire.writableEnded) wire.destroy(); }, async () => {
  f.authority.setNodeEnabled(f.credential.nodeId, false); f.authority.setNodeEnabled(f.credential.nodeId, true);
  wire.end(payload.slice(10)); assert.equal(await reply, 403); assert.equal(calls, 0);
  });
});

test("revoked reset result retains unknown mutation evidence and hides the queued receipt", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { identityReset: { currentGuid: () => guid, service: { available: () => true, status: async () => undefined,
    enqueue: async () => { entered(); await gate; return { operationId, state: "queued" }; } } } });
  const abort = new AbortController(), pending = f.send(resetPath, "POST", { operationId, expectedGuid: guid, confirmed: true }, abort.signal);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  f.authority.setNodeEnabled(f.credential.nodeId, false); release();
  const reply = await pending; assert.equal(reply.status, 403); assert.equal(reply.body.mutationOutcome, "unknown"); assert.equal(reply.body.uncertain, true);
  assert.equal(reply.body.data, undefined); assert.equal(JSON.stringify(reply.body).includes('"queued"'), false);
  });
});

test("an unavailable source receipt stays 503 and never becomes a missing-operation claim", async t => {
  const f = await fixture(t, { sourcePatches: { status: () => ({}) as any, operation: async () => { throw new Error("controlled receipt read failed"); } } });
  const reply = await f.send("/api/source-patches/operations/unavailable"); assert.equal(reply.status, 503); assert.match(reply.body.message, /do not replay/);
});

for (const change of ["service", "generation", "manager", "method", "both"] as const) test(`non-Lan source receipt denies original ${change} replacement after await`, async t => {
  let entered!: () => void, release!: () => void, replacementCalls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const source = { status: () => ({ state: "ready", queued: 0, modules: [] }), operation: async () => {
    entered(); await gate; return { operationId: "source-op", moduleId: "original-module", state: "committed", commitState: "committed", createdAt: "2026-01-01T00:00:00Z" } as any;
  } };
  const abort = new AbortController();
  const f = await fixture(t, { sourcePatches: source }, true), pending = f.send("/api/source-patches/operations/source-op", "GET", undefined, abort.signal);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  if (change === "service" || change === "both") Object.assign(f.context, { sourcePatches: { ...source, operation: async () => { replacementCalls++; return undefined; } } });
  if (change === "method") source.operation = async () => { replacementCalls++; return undefined; };
  if (change === "generation" || change === "both") f.managerIdentity.applicationGenerationId = "replacement-app";
  if (change === "manager") f.managerIdentity.managerInstanceId = "replacement-manager";
  release(); const reply = await pending;
  assert.equal(reply.status, 409, JSON.stringify(reply.body)); assert.equal(reply.body.data, undefined); assert.equal(JSON.stringify(reply.body).includes("original-module"), false); assert.equal(replacementCalls, 0);
  });
});

for (const change of ["service", "generation", "method", "both"] as const) test(`non-Lan reset pins original ${change} before incomplete JSON body`, async t => {
  let admitted!: () => void, originalCalls = 0, replacementCalls = 0;
  const prepared = new Promise<void>(resolve => { admitted = resolve; });
  const service = { available: () => { admitted(); return true; }, status: async () => undefined,
    enqueue: async () => { originalCalls++; return { operationId, state: "queued" as const }; } };
  const f = await fixture(t, { identityReset: { service, currentGuid: () => guid } }, true);
  const payload = JSON.stringify({ operationId, expectedGuid: guid, confirmed: true }); let wire!: http.ClientRequest;
  const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
    wire = http.request(f.base + resetPath, { method: "POST", headers: { ...f.headers, "content-length": Buffer.byteLength(payload) } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.once("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    }); wire.once("error", reject); wire.write(payload.slice(0, 10));
  });
  await withHandlerEntry(prepared, pending, () => { if (!wire.writableEnded) wire.destroy(); }, async () => {
  if (change === "service" || change === "both") Object.assign(f.context.identityReset, { service: { ...service, enqueue: async () => { replacementCalls++; return { operationId, state: "queued" }; } } });
  if (change === "method") service.enqueue = async () => { replacementCalls++; return { operationId, state: "queued" as const }; };
  if (change === "generation" || change === "both") f.managerIdentity.applicationGenerationId = "replacement-app";
  wire.end(payload.slice(10)); const reply = await pending;
  assert.equal(reply.status, 409, JSON.stringify(reply.body)); assert.equal(reply.body.commitState, "not_started"); assert.equal(originalCalls, 0); assert.equal(replacementCalls, 0);
  });
});

test("non-Lan authenticated connection keeps default access to every original public core operation", async t => {
  const f = await fixture(t, {}, true);
  for (const tail of ["/health", "/api/automatic-updates", "/api/source-patches", "/api/source-patches/operations/source-op", "/api/web-patches", "/api/web-patches/operations/committed"]) assert.equal((await f.send(tail)).status, 200, tail);
  assert.equal((await f.send("/api/agent/delivery-authority?deliveryId=missing&generation=missing")).status, 403);
  assert.equal((await f.send(resetPath + "/" + operationId)).status, 404);
  assert.equal((await f.send(resetPath, "POST", { operationId, expectedGuid: guid, confirmed: true })).status, 202);
});

for (const afterDispatch of [false, true]) test(`reset generation change ${afterDispatch ? "after" : "before"} original producer dispatch retains unknown outcome`, async t => {
  let entered!: () => void, release!: () => void, actualDispatches = 0, replacements = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = { available: () => true, status: async () => undefined,
    enqueue: async (_input: unknown, guard: () => void = () => {}) => {
      guard(); if (afterDispatch) actualDispatches++;
      entered(); await gate; guard(); if (!afterDispatch) actualDispatches++;
      return { operationId, state: "queued" as const };
    } };
  const f = await fixture(t, { identityReset: { service, currentGuid: () => guid } }, true);
  const abort = new AbortController(), pending = f.send(resetPath, "POST", { operationId, expectedGuid: guid, confirmed: true }, abort.signal);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  f.managerIdentity.applicationGenerationId = "replacement-app";
  Object.assign(f.context.identityReset, { service: { ...service, enqueue: async () => { replacements++; return { operationId, state: "queued" }; } } });
  release(); const reply = await pending;
  assert.equal(reply.status, 409, JSON.stringify(reply.body)); assert.equal(reply.body.commitState, "unknown"); assert.equal(reply.body.uncertain, true);
  assert.equal(actualDispatches, afterDispatch ? 1 : 0); assert.equal(replacements, 0); assert.equal(reply.body.data, undefined);
  });
});

test("a non-Lan admitted connection still loses disclosure immediately after ordinary revocation", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { sourcePatches: { status: () => ({}) as any, operation: async () => { entered(); await gate; return { moduleId: "private-old-data" } as any; } } }, true);
  const abort = new AbortController(), pending = f.send("/api/source-patches/operations/original", "GET", undefined, abort.signal);
  await withHandlerEntry(started, pending, () => { release(); abort.abort(); }, async () => {
  f.revokeConnection(); release();
  const reply = await pending; assert.equal(reply.status, 403); assert.equal(reply.body.data, undefined); assert.equal(JSON.stringify(reply.body).includes("private-old-data"), false);
  });
});

test("core metadata preserves the original contract and stays readable without diagnostics or business readiness", async t => {
  const metadata = { applicationGenerationId: "fixture", managerInstanceId: "manager", version: "fixture",
    health: { live: false, requiredReady: false, state: "starting", businessReady: false } };
  const f = await fixture(t, { metaPayload: () => metadata });
  assert.equal(f.definitions.length, 10);
  assert.equal(f.definitions.some(x => x.contract.operationId === "manager.gateways.read"), false);
  const operation = f.definitions.find(x => x.contract.operationId === "manager.meta.read"); assert.ok(operation);
  const originalContract = JSON.parse(await fs.readFile(new URL("./fixtures/manager-meta-contract.json", import.meta.url), "utf8"));
  assert.deepEqual(operation.contract, originalContract);
  const reply = await f.send("/meta"); assert.equal(reply.status, 200); assert.deepEqual(reply.body, metadata);
  assert.equal(reply.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(operation.contract.aliases, ["agent:GET:/meta"]);
  f.revokeConnection(); assert.equal((await f.send("/meta")).status, 403);
});

test("core metadata rechecks the original connection after awaiting its native owner", async t => {
  let entered!: () => void, finish!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const metadata = { applicationGenerationId: "fixture", managerInstanceId: "manager", health: { live: true, requiredReady: false, state: "degraded" } };
  const f = await fixture(t, { metaPayload: async () => { entered(); await gate; return metadata; } });
  assert.ok(f.definitions.some(x => x.contract.operationId === "manager.meta.read"), "Core metadata must exist before awaiting its native owner");
  const pending = f.send("/meta");
  try { await reading; f.revokeConnection(); finish(); assert.equal((await pending).status, 403); }
  finally { finish(); await pending.catch(() => {}); }
});
