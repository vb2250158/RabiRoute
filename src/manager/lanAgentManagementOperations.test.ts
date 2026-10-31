import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

test("existing targeted update selects one signed release with CAS and leaves other nodes on the common release", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const commonRoot = path.join(f.root, "common-agent"), candidate = path.join(f.root, "candidate-agent");
  for (const directory of [commonRoot, candidate]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "0.9.1" }));
    await fs.writeFile(path.join(directory, "rabi-agent.mjs"), directory === candidate ? "export const fixed = true;" : "export const fixed = false;");
  }
  const releases = new LanAgentReleaseStore({ rootDir: f.root, agentRoot: commonRoot });
  f.context.releases = releases;
  const original = releases.publication(); const selected = releases.importRelease(candidate);
  const update = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    releaseDigest: selected.releaseDigest, expectedReleaseDigest: original.releaseDigest } });
  assert.equal(update.statusCode, 202, String(update.body));
  assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  assert.deepEqual(releases.publication(f.caller.nodeId), original);
  const listed = await f.invoke("nodes.list"); assert.equal(listed.statusCode, 200);
  const listedNodes = JSON.parse(String(listed.body)).nodes as Array<{ nodeId: string; releaseDigest: string }>;
  assert.equal(listedNodes.find(node => node.nodeId === f.worker.nodeId)?.releaseDigest, selected.releaseDigest);
  assert.equal(listedNodes.find(node => node.nodeId === "historical-node")?.releaseDigest, original.releaseDigest);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(call => call.type === "updateAvailable" && call.version === selected.version));
  const count = f.calls.filter(call => call.type === "updateAvailable").length;
  const conflict = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    releaseDigest: null, expectedReleaseDigest: original.releaseDigest } });
  assert.equal(conflict.statusCode, 409); assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  const missing = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    releaseDigest: "f".repeat(64), expectedReleaseDigest: selected.releaseDigest } });
  assert.equal(missing.statusCode, 400); assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  const ambiguous = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    version: selected.version, releaseDigest: null, expectedReleaseDigest: selected.releaseDigest } });
  assert.equal(ambiguous.statusCode, 400); assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  const noCompare = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: { releaseDigest: null } });
  assert.equal(noCompare.statusCode, 400); assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  assert.equal(f.calls.filter(call => call.type === "updateAvailable").length, count);
  const restored = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    releaseDigest: null, expectedReleaseDigest: selected.releaseDigest } });
  assert.equal(restored.statusCode, 202); assert.deepEqual(releases.publication(f.worker.nodeId), original);
  assert.deepEqual(releases.publication(f.caller.nodeId), original);
  const advertised = f.api.catalogSnapshot().operations.find(row => row.contract.operationId === "manager.lan-agent.nodes.update");
  assert.ok(JSON.stringify(advertised).includes("expectedReleaseDigest"));
  // The durable selection is not rolled back or replayed if notification cannot be confirmed.
  t.mock.method(f.nodes, "requestUpdate", () => { throw new Error("fixture notification interrupted"); });
  const uncertain = await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {
    releaseDigest: selected.releaseDigest, expectedReleaseDigest: original.releaseDigest } });
  assert.equal(uncertain.statusCode, 400); assert.equal(JSON.parse(String(uncertain.body)).uncertain, true);
  assert.deepEqual(releases.publication(f.worker.nodeId), selected);
  assert.deepEqual(releases.publication(f.caller.nodeId), original);
});

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "management-operations-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const caller = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-control");
  const worker = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-worker");
  // Retained v1 records must remain readable without invented modern fields.
  await fs.writeFile(path.join(root, "nodes.json"), JSON.stringify({ schemaVersion: 2,
    nodes: [{ nodeId: "historical-node", connected: false, historicalExtension: "retained" }],
    tasks: [{ taskId: "historical-task", nodeId: "historical-node", status: "completed", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }] }));
  const nodes = new LanAgentRegistry({ statePath: path.join(root, "nodes.json"), authenticateNode: token => authority.authenticate(token) });
  const agentRoot = path.join(root, "release"); await fs.mkdir(agentRoot);
  await fs.writeFile(path.join(agentRoot, "package.json"), JSON.stringify({ version: "fixture-release" }));
  await fs.writeFile(path.join(agentRoot, "rabi-agent.mjs"), "export const fixture = true;\n");
  const meta = { applicationGenerationId: "management-app", managerInstanceId: "management-manager", pluginGenerationId: "management-plugins", health: { live: true, requiredReady: true, state: "healthy" } };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => meta });
  const context: LanAgentRoutesContext = { registry: nodes, authority, enabled: () => true, managerIdentity: () => meta,
    readJsonBody: async () => { throw new Error("Executable operations own decoding."); }, jsonResponse: () => { throw new Error("Executable operations own responses."); },
    isManagementRequestAuthorized: () => false, isReleaseRequestAuthorized: () => false,
    releases: new LanAgentReleaseStore({ rootDir: root, agentRoot }),
    manageLocalAgent: async (agentId, operation, body, guard) => { guard?.(); return { agentId, operation, body, localExtension: true }; } };
  const registration = api.registerOperations("management", createLanAgentManagementOperations(context));
  const discovery = api.registerOperations("discovery", createApiDiscoveryOperations(api));
  const server = http.createServer((request, response) => {
    const admitted = evaluateLanAgentRequest(request, authority, true);
    if (admitted.kind === "denied") { response.writeHead(admitted.status).end(); return; }
    if (admitted.kind === "agent") markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (request.headers.authorization === "Bearer fixture-link") markAuthenticatedConnectionRequest(request);
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!api.handle(request, url, response)) response.writeHead(404).end();
  });
  const detach = nodes.attach(server, { getToken: () => "", enabled: () => true });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(base.replace("http:", "ws:") + "/api/lan-agent/connect");
  const calls: Array<Record<string, any>> = [];
  let intercept: ((message: Record<string, any>) => boolean) | undefined;
  const reply = (message: Record<string, any>) => {
    if (message.type === "manageAgent") socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result: { operation: message.operation, params: message.params, providerExtension: "retained" } }));
    if (message.type === "assignTask") socket.send(JSON.stringify({ type: "progress", taskId: message.task.taskId, summary: "original task accepted" }));
  };
  const connected = new Promise<void>((resolve, reject) => {
    socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token: worker.token })));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "hello", node: { nodeId: worker.nodeId, version: "fixture", platform: "fixture", agents: [], agentTypes: ["dsh"], taskTargeting: "explicit-session-v1" } }));
      if (message.type === "connected") resolve();
      if (["manageAgent", "assignTask", "updateAvailable"].includes(message.type)) { calls.push(message); if (!intercept?.(message)) reply(message); }
    }); socket.once("error", reject);
  });
  t.after(async () => { socket.terminate(); detach(); nodes.close(); server.closeAllConnections(); await Promise.all([registration.dispose(), discovery.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  await connected;
  const client = createManagerClient({ managerUrl: base, credential: caller.token, agentType: "dsh", sessionId: "fixture-unregistered-session" });
  const invoke = (key: string, options: Record<string, any> = {}) => client.invokeOperation(`manager.lan-agent.${key}`, options);
  const auth = { authorization: `Bearer ${caller.token}` };
  return { root, authority, caller, worker, nodes, api, registration, socket, base, client, context, calls, reply, invoke, auth,
    intercept: (callback: typeof intercept) => { intercept = callback; } };
}

test("management discovery contains all fifteen real routes, optional ignored bodies and no issued secrets", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.api.catalogSnapshot().operations.length, 18);
  const response = await fetch(f.base + "/api/agent/openapi", { headers: f.auth });
  const spec = await response.json() as any;
  assert.equal(spec.paths["/api/lan-agent/enrollments"].post.requestBody.required, false);
  assert.ok(spec.paths["/api/lan-agent/instances/{instanceId}/agents/{agentId}/hooks"].post);
  assert.equal(JSON.stringify(spec).includes(f.caller.token), false);
  assert.equal((await fetch(f.base + "/api/lan-agent/nodes")).status, 401);
  assert.equal((await fetch(f.base + "/api/lan-agent/nodes", { headers: { authorization: "Bearer fixture-link" } })).status, 200);
  const history = await f.invoke("nodes.list"); assert.equal(history.statusCode, 200, String(history.body));
  const data = JSON.parse(String(history.body)); assert.equal(data.nodes.find((node: any) => node.nodeId === "historical-node").historicalExtension, "retained");
  assert.equal(data.tasks.find((task: any) => task.taskId === "historical-task").threadId, undefined);
  assert.deepEqual(f.nodes.getNode(f.worker.nodeId)!.agents, []);
});

test("ticket issuance ignores empty or arbitrary bodies and enrollment recovers the original credential", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const body of [undefined, "{not-json"] ) {
    const response = await fetch(f.base + "/api/lan-agent/enrollments", { method: "POST", headers: { ...f.auth, "content-type": "text/plain" }, body });
    assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
    const ticket = (await response.json() as any).data.ticket;
    const secret = randomBytes(32).toString("base64url"); const nodeId = body ? "enroll-raw" : "enroll-empty";
    const enroll = (payload: unknown) => fetch(f.base + "/api/lan-agent/enroll", { method: "POST", body: JSON.stringify(payload) });
    const first = await enroll({ ticket, nodeId, enrollmentSecret: secret }); assert.equal(first.status, 201);
    const issued = (await first.json() as any).data;
    const recovered = await enroll({ nodeId, enrollmentSecret: secret }); assert.equal(recovered.status, 201);
    assert.deepEqual((await recovered.json() as any).data, issued);
    assert.equal((await enroll({ ticket, nodeId: "duplicate-ticket-use" })).status, 400);
    assert.equal((await enroll({ nodeId, enrollmentSecret: false })).status, 400);
  }
  const self = await f.invoke("self.read"); assert.equal(self.statusCode, 200);
  assert.equal(JSON.parse(String(self.body)).data.nodeId, f.caller.nodeId);
  assert.equal((await fetch(f.base + "/api/lan-agent/self", { headers: { authorization: "Bearer fixture-link" } })).status, 401);
});

test("instance name/enabled changes use the original compare-and-set owners with independent readback", { timeout: 15000 }, async t => {
  const f = await fixture(t), target = { instanceId: f.worker.nodeId };
  const renamed = await f.invoke("instances.name", { path: target, body: { expectedName: "", name: "Fixture worker" } }); assert.equal(renamed.statusCode, 200);
  assert.equal((await f.invoke("instances.name", { path: target, body: { expectedName: "", name: "stale" } })).statusCode, 409);
  const read = JSON.parse(String((await f.invoke("instances.list")).body));
  assert.equal(read.instances.find((row: any) => row.instanceId === f.worker.nodeId).name, "Fixture worker");
  assert.equal((await f.invoke("instances.enabled", { path: target, body: { expectedEnabled: true, enabled: false } })).statusCode, 200);
  assert.equal((await f.invoke("instances.enabled", { path: target, body: { expectedEnabled: true, enabled: true } })).statusCode, 409);
  assert.equal((await f.invoke("instances.enabled", { path: target, body: { expectedEnabled: false, enabled: true } })).statusCode, 200);
  assert.equal(f.authority.isNodeEnabled(f.worker.nodeId), true);
  assert.equal((await f.invoke("instances.enabled", { path: target, body: { enabled: "false", expectedEnabled: true } })).statusCode, 400);
});

test("all provider management operations retain the native owner, explicit adapter and path target", { timeout: 15000 }, async t => {
  const f = await fixture(t), target = { instanceId: f.worker.nodeId, agentId: "selected-provider" };
  for (const key of ["create", "configure", "scan", "threads", "hooks"]) {
    const result = await f.invoke(`agents.${key}`, { path: key === "create" ? { instanceId: target.instanceId } : target,
      body: { agentId: "body-must-not-change-target", agentAdapter: "dsh", customProviderField: { keep: true } } });
    assert.equal(result.statusCode, 200, String(result.body));
    const data = JSON.parse(String(result.body)).result;
    assert.equal(data.providerExtension, "retained"); assert.deepEqual(data.params.customProviderField, { keep: true });
    assert.equal(data.params.agentId, key === "create" ? undefined : target.agentId);
  }
  const before = f.calls.length;
  assert.equal((await f.invoke("agents.threads", { path: target, body: { action: "list" } })).statusCode, 400);
  assert.equal(f.calls.length, before);
  const local = await f.invoke("agents.tasks", { path: { instanceId: f.nodes.localInstanceId, agentId: "local-provider" }, body: { message: "local target uses original provider" } });
  assert.equal(local.statusCode, 200, String(local.body)); assert.equal(JSON.parse(String(local.body)).result.localExtension, true);
});

test("explicit-session tasks await acceptance, retain receipts and do not dispatch duplicates", { timeout: 15000 }, async t => {
  const f = await fixture(t), body = { targetAgent: "dsh", threadId: "complete-target-session", message: "same task", idempotencyKey: "management-task-receipt" };
  const first = await f.invoke("nodes.tasks", { path: { nodeId: f.worker.nodeId }, body }); assert.equal(first.statusCode, 202, String(first.body));
  const receipt = JSON.parse(String(first.body)).result; assert.equal(receipt.status, "progress"); assert.equal(receipt.threadId, body.threadId);
  const repeated = await f.invoke("nodes.tasks", { path: { nodeId: f.worker.nodeId }, body }); assert.equal(repeated.statusCode, 202);
  assert.equal(JSON.parse(String(repeated.body)).result.taskId, receipt.taskId);
  assert.equal(f.calls.filter(call => call.type === "assignTask").length, 1);
  assert.equal((await f.invoke("nodes.tasks", { path: { nodeId: f.worker.nodeId }, body: { ...body, message: "conflicting use" } })).statusCode, 400);
  const instance = await f.invoke("agents.tasks", { path: { instanceId: f.worker.nodeId, agentId: "display-only" }, body: { provider: "dsh", threadId: body.threadId, message: "instance task", idempotencyKey: "instance-task-receipt" } });
  assert.equal(instance.statusCode, 200); assert.equal(JSON.parse(String(instance.body)).result.threadId, body.threadId);
  assert.equal((await f.invoke("nodes.update", { path: { nodeId: f.worker.nodeId }, body: {} })).statusCode, 202);
  const received = f.calls.some(call => call.type === "updateAvailable" && call.version === "fixture-release");
  if (!received) await new Promise<void>(resolve => f.socket.once("message", () => resolve()));
  assert.equal(f.calls.filter(call => call.type === "updateAvailable").length, 1);
});

test("aborted management calls retain the lease until the original remote owner settles", { timeout: 15000 }, async t => {
  const f = await fixture(t); let sent!: () => void, held!: Record<string, any>;
  const entered = new Promise<void>(resolve => { sent = resolve; });
  f.intercept(message => { held = message; sent(); return true; });
  const controller = new AbortController();
  const request = f.invoke("agents.hooks", { path: { instanceId: f.worker.nodeId, agentId: "fixture" }, body: {}, signal: controller.signal });
  await entered; controller.abort(); await request;
  let retired = false; const stopped = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  f.reply(held); await stopped; assert.equal(f.calls.length, 1);
});

test("revocation/re-enable during an awaited operation cannot disclose the old result or replay it", { timeout: 15000 }, async t => {
  const f = await fixture(t); let sent!: () => void, held!: Record<string, any>;
  const entered = new Promise<void>(resolve => { sent = resolve; });
  f.intercept(message => { held = message; sent(); return true; });
  const request = f.invoke("agents.configure", { path: { instanceId: f.worker.nodeId, agentId: "fixture" }, body: {} });
  await entered; f.authority.setNodeEnabled(f.caller.nodeId, false, true); f.authority.setNodeEnabled(f.caller.nodeId, true, false);
  f.reply(held); const result = await request;
  assert.equal(result.statusCode, 403); assert.doesNotMatch(String(result.body), /providerExtension/); assert.equal(f.calls.length, 1);
});

test("task/update owners fence dispatch after persistence and retain uncertain records without sending", { timeout: 15000 }, async t => {
  const f = await fixture(t), native = f.nodes as unknown as { persist(): void };
  const persist = native.persist.bind(native); let active = true;
  const guard = () => { if (!active) throw new Error("Original admission revoked during persistence."); };
  native.persist = () => { persist(); active = false; };
  try {
    assert.throws(() => f.nodes.assignTask({ nodeId: f.worker.nodeId, targetAgent: "dsh", threadId: "explicit-session", message: "preserve receipt", idempotencyKey: "persisted-original" }, guard), /revoked/);
    assert.equal(f.nodes.listTasks(100).find(task => task.idempotencyKey === "persisted-original")!.status, "queued");
    active = true;
    assert.throws(() => f.nodes.requestUpdate(f.worker.nodeId, "fixture-next", guard), /revoked/);
    assert.equal(f.nodes.getNode(f.worker.nodeId)!.updateState, "requested");
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
  } finally { native.persist = persist; }
});
