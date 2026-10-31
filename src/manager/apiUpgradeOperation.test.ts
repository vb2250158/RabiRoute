import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocket, type WebSocketServer } from "ws";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { createLanAgentConnectionOperation, LAN_AGENT_WEBSOCKET_LIMITS } from "./lanAgentConnectionOperation.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import { createRabiManagerPluginHostApi } from "./managerPluginPackageHost.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: import("node:test").TestContext, publication?: { read(): ReadonlySet<string>; identity: PluginIdentity }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "api-upgrade-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-upgrade-node");
  const nodes = new LanAgentRegistry({ statePath: path.join(root, "nodes.json"), authenticateNode: token => authority.acquireConnectionLease(token) });
  let enabled = true;
  const meta = { applicationGenerationId: "upgrade-app", managerInstanceId: "upgrade-manager", pluginGenerationId: "upgrade-plugins", health: { live: true, requiredReady: true, state: "healthy" } };
  const api = new ManagerPluginRouteRegistry(publication?.read, { identity: () => meta });
  const definition = createLanAgentConnectionOperation(nodes, { enabled: () => enabled, getToken: () => "" });
  const registration = publication ? runPluginActivation(publication.identity, () => api.registerUpgrades("upgrade", [definition])) : api.registerUpgrades("upgrade", [definition]);
  const discovery = publication ? runPluginActivation({ ...publication.identity, instanceId: "discovery", activationId: "discovery" }, () => api.registerOperations("discovery", createApiDiscoveryOperations(api)))
    : api.registerOperations("discovery", createApiDiscoveryOperations(api));
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(401).end(); return; }
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const url = new URL(request.url!, "http://fixture.invalid");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!api.handle(request, url, response)) response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => { if (!api.handleUpgrade(request, new URL(request.url!, "http://fixture.invalid"), socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, clients: WebSocket[] = [];
  t.after(async () => { for (const socket of clients) socket.terminate(); await Promise.all([registration.dispose(), discovery.dispose()]); nodes.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const open = async (headers?: Record<string, string>, target = definition.contract.pathTemplate) => {
    const socket = new WebSocket(base.replace("http:", "ws:") + target, { headers }); clients.push(socket); socket.on("error", () => {});
    const rows: Array<Record<string, any>> = [], waiters = new Set<() => void>();
    socket.on("message", raw => { rows.push(JSON.parse(raw.toString())); for (const waiter of [...waiters]) waiter(); });
    const wait = async (type: string) => {
      const found = () => rows.find(row => row.type === type);
      if (found()) return found()!;
      return new Promise<Record<string, any>>(resolve => { const ready = () => { if (found()) { waiters.delete(ready); resolve(found()!); } }; waiters.add(ready); });
    };
    await once(socket, "open");
    return { socket, rows, wait, authenticate: async () => {
      socket.send(JSON.stringify({ type: "authenticate", token: credential.token })); await wait("authenticated");
      socket.send(JSON.stringify({ type: "hello", node: { nodeId: credential.nodeId, version: "fixture", platform: "fixture", agents: [] } })); await wait("connected");
    } };
  };
  const client = createManagerClient({ managerUrl: base, credential: credential.token });
  return { root, nodes, authority, credential, api, definition, registration, discovery, base, client, open, enabled: (value: boolean) => { enabled = value; } };
}

test("discovery/OpenAPI and actual upgrade use one executable contract without HTTP-only admission", { timeout: 15000 }, async t => {
  const f = await fixture(t), snapshot = f.api.catalogSnapshot();
  assert.equal(snapshot.operations.length, 4); assert.equal(snapshot.coverage.globalCoverage, "not-proven");
  const spec = (await apiCatalogOpenApi(snapshot)) as any, operation = spec.paths["/api/lan-agent/connect"].get;
  assert.equal(operation["x-rabiroute-transport"], "websocket"); assert.equal(operation.responses["101"].content, undefined);
  const selected = snapshot.operations.find(row => row.contract.operationId === "manager.lan-agent.connect")!;
  const connection = await f.open({ "x-rabiroute-api-contract": selected.contractDigest });
  await connection.authenticate(); assert.deepEqual(f.nodes.getNode(f.credential.nodeId)!.agents, []);
  assert.equal(f.registration.activeOperationCount(), 1); assert.equal(f.nodes.listTasks().length, 0);
  const ordinary = await f.client.request("GET", selected.contract.pathTemplate); assert.equal(ordinary.statusCode, 426);
  await assert.rejects(() => f.client.invokeOperation("manager.lan-agent.connect"), /compatible connector/);
  connection.socket.close(); await once(connection.socket, "close"); await f.registration.dispose(); assert.equal(f.registration.activeOperationCount(), 0);
  assert.equal(f.nodes.listNodes()[0]!.connected, false);
});

test("wrong contract and disabled admission reject before upgrade; wrong first-message credential retains native 1008", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const rejected = (headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(f.base.replace("http:", "ws:") + "/api/lan-agent/connect", { headers }); socket.on("error", () => {});
    socket.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); });
    socket.on("open", () => { socket.terminate(); reject(new Error("Unexpected upgrade acceptance.")); });
  });
  assert.equal(await rejected({ "x-rabiroute-api-contract": "stale" }), 409);
  f.enabled(false); assert.equal(await rejected(), 401); f.enabled(true);
  const connection = await f.open(); const closed = once(connection.socket, "close");
  connection.socket.send(JSON.stringify({ type: "authenticate", token: "invalid-fixture-credential" })); assert.equal((await closed)[0], 1008);
  assert.equal(f.nodes.listNodes().length, 0);
});

test("retiring HTTP commands drains their native results before closing transport admission and sessions", { timeout: 15000 }, async t => {
  const f = await fixture(t), connection = await f.open(); await connection.authenticate();
  const entered = deferred<void>();
  const commands = f.api.registerOperations("command", [{ contract: fixtureApiContract(), handler: async () => {
    entered.resolve(); const result = await f.nodes.manageAgent(f.credential.nodeId, "scan", {}, 5000);
    return { status: 200, body: { ok: true, value: result } };
  } }]);
  t.after(() => commands.dispose());
  const sent = f.client.request("POST", "/api/example/records/one", { body: { value: 1 } });
  await Promise.race([entered.promise, sent.then(result => { throw new Error(`Command did not reach owner: ${result.statusCode} ${result.body}`); })]);
  const message = await connection.wait("manageAgent"); f.registration.stopAccepting();
  let stopped = false; const retire = (async () => { await commands.dispose(); await f.registration.dispose(); stopped = true; })();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(connection.socket.readyState, WebSocket.OPEN);
  connection.socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result: 7 }));
  assert.equal((await sent).statusCode, 200); await retire;
  assert.equal(connection.rows.filter(row => row.type === "manageAgent").length, 1); assert.equal(f.registration.activeOperationCount(), 0);
});

test("new publication proceeds with an idle channel and failed candidates preserve its active contract", { timeout: 15000 }, async t => {
  const f = await fixture(t), connection = await f.open(); await connection.authenticate();
  const previous = f.api.catalogSnapshot();
  assert.throws(() => f.api.registerUpgrades("broken", [{ ...f.definition, contract: { ...f.definition.contract,
    websocket: { ...f.definition.contract.websocket!, incomingSchema: { type: "invalid-schema-type" } } } } ]));
  assert.equal(f.api.catalogSnapshot(), previous);
  const extra = f.api.registerOperations("extra", [{ contract: fixtureApiContract(), handler: () => ({ status: 200, body: { ok: true, value: 3 } }) }]);
  assert.ok(f.api.catalogSnapshot().catalogRevision > previous.catalogRevision); assert.equal(connection.socket.readyState, WebSocket.OPEN);
  assert.equal(f.registration.activeOperationCount(), 1); await extra.dispose();
});

test("activation publication keeps the old upgrade owner until its own registration retires", { timeout: 15000 }, async t => {
  let published = new Set(["old", "discovery"]);
  const identity: PluginIdentity = { applicationGenerationId: "app", managerInstanceId: "manager", host: "manager", pluginId: "fixture", instanceId: "upgrade", activationId: "old", version: "1.0.0", revision: "old" };
  const f = await fixture(t, { read: () => published, identity });
  const first = f.api.catalogSnapshot(), connection = await f.open(); await connection.authenticate();
  const next = runPluginActivation({ ...identity, activationId: "new", revision: "new" }, () => f.api.registerUpgrades("upgrade", [{ ...f.definition, contract: { ...f.definition.contract, contractVersion: "2.0.0" } }]));
  t.after(() => next.dispose()); assert.equal(f.api.catalogSnapshot(), first); published = new Set(["new", "discovery"]);
  const changed = f.api.refreshPublication(); assert.equal(changed.operations.find(row => row.contract.transport === "websocket")!.contract.contractVersion, "2.0.0");
  assert.equal(connection.socket.readyState, WebSocket.OPEN); assert.equal(f.registration.activeOperationCount(), 1);
  const replacement = await f.open(); replacement.socket.send(JSON.stringify({ type: "authenticate", token: f.credential.token })); await replacement.wait("authenticated");
  await f.registration.dispose(); assert.equal(f.api.catalogSnapshot(), changed); assert.equal(replacement.socket.readyState, WebSocket.OPEN);
  await next.dispose();
});

test("native buffered-byte overload closes the channel before another management message is sent", { timeout: 15000 }, async t => {
  const f = await fixture(t), connection = await f.open(); await connection.authenticate();
  const native = f.nodes as unknown as { connections: Map<string, { socket: WebSocket }> };
  Object.defineProperty(native.connections.get(f.credential.nodeId)!.socket, "bufferedAmount", { configurable: true, get: () => LAN_AGENT_WEBSOCKET_LIMITS.maxBufferedBytes });
  await assert.rejects(f.nodes.manageAgent(f.credential.nodeId, "scan", {}, 5000), /capacity|disconnected/);
  await f.registration.dispose(); assert.equal(connection.rows.some(row => row.type === "manageAgent"), false);
});

test("retirement retains the lease for asynchronous owner cleanup after the socket has closed", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>(); t.after(() => release.resolve());
  const registration = f.api.registerUpgrades("cleanup", [{ contract: { ...f.definition.contract, operationId: "example.cleanup", pathTemplate: "/api/example/cleanup" },
    handler: input => f.definition.handler({ ...input, accept: session => input.accept({ closed: session.closed, close: async reason => {
      await session.close(reason); entered.resolve(); await release.promise;
    } }) }) }]);
  t.after(() => registration.dispose());
  const connection = await f.open(undefined, "/api/example/cleanup"); await connection.authenticate();
  let stopped = false; const disposed = registration.dispose().then(() => { stopped = true; });
  await entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.equal(registration.activeOperationCount(), 1);
  release.resolve(); await disposed; assert.equal(registration.activeOperationCount(), 0);
});

test("revocation and re-enable cannot revive the original authenticated native channel", { timeout: 15000 }, async t => {
  const f = await fixture(t), connection = await f.open(); await connection.authenticate();
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false);
  const closed = once(connection.socket, "close"); connection.socket.send(JSON.stringify({ type: "heartbeat" }));
  assert.equal((await closed)[0], 1008); await f.registration.dispose();
  assert.equal(f.nodes.listNodes()[0]!.connected, false);
});

test("native instances with the earlier field layout retain old sockets and initialize new upgrade state once", { timeout: 15000 }, async t => {
  const f = await fixture(t), connection = await f.open(); await connection.authenticate();
  const native = f.nodes as unknown as { wss: WebSocketServer; protocolGuards?: unknown; upgradeInputs?: unknown; upgradeHeadersInstalled?: boolean };
  delete native.protocolGuards; delete native.upgradeInputs; delete native.upgradeHeadersInstalled; native.wss.removeAllListeners("headers");
  const command = f.nodes.manageAgent(f.credential.nodeId, "scan", {}, 5000), message = await connection.wait("manageAgent");
  connection.socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result: "original owner result" }));
  assert.equal(await command, "original owner result");
  const next = await f.open(); assert.equal(next.socket.readyState, WebSocket.OPEN); assert.equal(native.wss.listenerCount("headers"), 1);
  assert.ok(native.protocolGuards); assert.ok(native.upgradeInputs); await f.registration.dispose();
});

test("a frame racing retirement closes the old connection without an error-response loop", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>(); t.after(() => release.resolve());
  const registration = f.api.registerUpgrades("retire-race", [{ contract: { ...f.definition.contract, operationId: "example.retire", pathTemplate: "/api/example/retire" },
    handler: input => f.definition.handler({ ...input, accept: session => input.accept({ closed: session.closed, close: async reason => {
      entered.resolve(); await release.promise; await session.close(reason);
    } }) }) }]);
  t.after(() => registration.dispose()); const connection = await f.open(undefined, "/api/example/retire"); await connection.authenticate();
  const close = once(connection.socket, "close"), disposed = registration.dispose(); await entered.promise;
  connection.socket.send(JSON.stringify({ type: "heartbeat" })); assert.equal((await close)[0], 1001);
  assert.equal(registration.activeOperationCount(), 1); release.resolve(); await disposed;
});

test("generic plugin retirement drains accepted legacy HTTP work before its owned upgrade transport", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = deferred<void>();
  const host = createRabiManagerPluginHostApi({ instanceId: "hosted", routes: f.api, publishManagerEvent: () => {} }); t.after(() => host.stop());
  host.registerUpgrades([{ ...f.definition, contract: { ...f.definition.contract, operationId: "example.hosted", pathTemplate: "/api/example/hosted-transport" } }]);
  const connection = await f.open(undefined, "/api/example/hosted-transport"); await connection.authenticate();
  host.registerRoutes([{ routeId: "hosted-command", match: { kind: "exact", path: "/api/example/legacy-command", methods: ["POST"] }, handler: (_request, _url, response) => {
    entered.resolve(); void host.track(f.nodes.manageAgent(f.credential.nodeId, "scan", {}, 5000).then(value => {
      if (!response.destroyed) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ value })); }
    }).catch(() => { if (!response.destroyed) response.writeHead(500).end(); })); return true;
  } }]);
  const request = f.client.request("POST", "/api/example/legacy-command", { body: {} }); await entered.promise;
  const message = await connection.wait("manageAgent"), stopping = host.stop();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(connection.socket.readyState, WebSocket.OPEN);
  connection.socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result: 11 }));
  assert.equal((await request).statusCode, 200); await stopping;
});
