import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { RemoteAgentHub, type RemoteAgentTaskEvent } from "../messageEndpoints/remoteAgentManager.js";
import { createRemoteAgentOperations } from "./remoteAgentRoutes.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-hub-operations-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const bridge = http.createServer(), wss = new WebSocketServer({ noServer: true });
  bridge.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/remote-agent/control") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
  });
  const password = randomBytes(24).toString("base64url"), deviceId = "fixture-v3-bridge", wireTasks: Array<Record<string, any>> = [], notifications = new EventEmitter();
  let holdRegistration: ((finish: () => void) => void) | undefined;
  wss.on("connection", socket => {
    const nonce = randomBytes(32).toString("base64url");
    const proof = (role: string) => createHmac("sha256", password).update(`rabiroute.remote-agent.v3:${role}:${nonce}`).digest("base64url");
    socket.send(JSON.stringify({ type: "challenge", protocolVersion: 3, algorithm: "hmac-sha256", nonce }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") {
        if (message.proof !== proof("manager")) { socket.send(JSON.stringify({ type: "error", error: "Invalid fixture bridge password." })); socket.close(); return; }
        const finish = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "registered", protocolVersion: 3, serverProof: proof("server"), device: { deviceId, deviceName: "Fixture bridge" } })); };
        if (holdRegistration) holdRegistration(finish); else finish();
      }
      if (message.type === "task") { wireTasks.push(message.task); notifications.emit("task"); }
    });
  });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const bridgeAddress = bridge.address(); assert.ok(bridgeAddress && typeof bridgeAddress !== "string");
  const discovered = { deviceId, deviceName: "Fixture bridge", host: "127.0.0.1", port: bridgeAddress.port,
    controlUrl: `ws://127.0.0.1:${bridgeAddress.port}/api/remote-agent/control`, protocolVersion: 3, discoveredAt: new Date().toISOString() };
  let callback: ((event: RemoteAgentTaskEvent) => Promise<void>) | undefined;
  const records: Array<Record<string, any>> = [], events: RemoteAgentTaskEvent[] = [];
  const hub = new RemoteAgentHub({ managerPort: 0, passwordStorePath: path.join(root, "connections.json"), fileStoreDir: path.join(root, "returned"),
    getDefaultGatewayId: () => "fixture-gateway", onConversationRecord: record => { records.push(record); },
    onTaskEvent: async (_task, event) => { events.push(event); await callback?.(event); } });
  // Only LAN discovery is controlled; actual Hub maps, HMAC handshake, sockets/files/callbacks are native.
  const native = hub as unknown as { discoverRemoteAgents(): Promise<Array<typeof discovered>> };
  native.discoverRemoteAgents = async () => [discovered];
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-caller");
  const meta = { applicationGenerationId: "hub-app", managerInstanceId: "hub-manager", pluginGenerationId: "hub-plugins", health: { live: true, requiredReady: true, state: "healthy" } };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => meta });
  const registration = api.registerOperations("remote-hub", createRemoteAgentOperations({ listDevices: () => hub.listDevices(), listTasks: limit => hub.listTasks(limit),
    scanLan: guard => hub.scanLan(undefined, guard), connectDevice: (body, guard) => hub.connectDevice(body, guard),
    disconnectDevice: (id, guard) => hub.disconnectDevice(id, guard), createTask: (body, guard) => hub.createTask(body, guard),
    receiveTaskEvent: (event, guard) => hub.receiveTaskEvent(event, undefined, guard),
    applyTaskDefaults: body => ({ ...body, originGatewayId: body.originGatewayId || "fixture-gateway" }) }));
  const discovery = api.registerOperations("discovery", createApiDiscoveryOperations(api));
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind === "denied") { response.writeHead(access.status).end(); return; }
    if (access.kind === "agent") markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    else if (request.headers.authorization === "Bearer fixture-link") markAuthenticatedConnectionRequest(request);
    else { response.writeHead(401).end(); return; }
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!api.handle(request, url, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { hub.stopAccepting(); server.closeAllConnections(); await Promise.all([registration.dispose(), discovery.dispose()]); await hub.shutdown();
    for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve()));
    await Promise.all([new Promise<void>(resolve => bridge.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]); });
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "dsh", sessionId: "unregistered-hub-session" });
  const invoke = (key: string, options: Record<string, any> = {}) => client.invokeOperation(`manager.remote-agent.${key}`, options);
  const connect = async () => { assert.equal((await invoke("scan")).statusCode, 200); const result = await invoke("connect", { body: { deviceId, password } }); assert.equal(result.statusCode, 200, String(result.body)); };
  return { root, password, deviceId, discovered, native, hub, authority, credential, api, registration, client, base, invoke, connect, records, events, wireTasks,
    waitForTask: async () => { if (!wireTasks.length) await once(notifications, "task"); return wireTasks.at(-1)!; },
    holdRegistration: (value: typeof holdRegistration) => { holdRegistration = value; }, callback: (value: typeof callback) => { callback = value; } };
}

test("seven executable Hub contracts retain shared remote admission, schema projections and ignored scan input", { timeout: 15000 }, async t => {
  const f = await fixture(t); assert.equal(f.api.catalogSnapshot().operations.length, 10);
  assert.equal((await fetch(f.base + "/api/remote-agent/devices")).status, 401);
  assert.equal((await fetch(f.base + "/api/remote-agent/devices", { headers: { authorization: "Bearer fixture-link" } })).status, 200);
  const scan = await fetch(f.base + "/api/remote-agent/scan", { method: "POST", headers: { authorization: `Bearer ${f.credential.token}`, "content-type": "text/plain" }, body: "{ignored-invalid-json" });
  assert.equal(scan.status, 200); assert.equal((await scan.json() as any).devices[0].deviceId, f.deviceId);
  const spec = await f.client.request("GET", "/api/agent/openapi"); assert.equal(spec.statusCode, 200);
  const document = JSON.parse(String(spec.body)); assert.equal(document.paths["/api/remote-agent/scan"].post.requestBody.required, false);
  assert.equal(Object.keys(document.paths).filter(key => key.startsWith("/api/remote-agent/")).length, 6);
  assert.equal(JSON.stringify(document).includes(f.password), false);
  const methods = await fetch(f.base + "/api/remote-agent/devices", { method: "PUT", headers: { authorization: `Bearer ${f.credential.token}` } });
  assert.equal(methods.status, 405);
});

test("real HMAC bridge connection and one task dispatch retain native files, defaults and in-memory recovery limits", { timeout: 15000 }, async t => {
  const f = await fixture(t); assert.equal((await f.invoke("scan")).statusCode, 200);
  assert.equal((await f.invoke("connect", { body: { deviceId: f.deviceId, password: "wrong-fixture-password" /* Public test-only fixture; not a real credential. */ } })).statusCode, 400);
  assert.equal(await fs.stat(path.join(f.root, "connections.json")).then(() => true, () => false), false);
  await f.connect(); const source = path.join(f.root, "source.txt"); await fs.writeFile(source, "original fixture bytes 汉字");
  const created = await f.invoke("tasks.create", { body: { deviceId: f.deviceId, message: 42, filePaths: [source], originReplyContext: { extension: true } } });
  assert.equal(created.statusCode, 202, String(created.body)); const task = JSON.parse(String(created.body)).task;
  assert.equal(task.message, "42"); assert.equal(task.originGatewayId, "fixture-gateway"); assert.equal(task.status, "delivered");
  assert.equal(task.files[0].contentBase64, undefined);
  const wire = await f.waitForTask(); assert.equal(Buffer.from(wire.files[0].contentBase64, "base64").toString(), "original fixture bytes 汉字");
  assert.equal(f.wireTasks.length, 1);
  const listed = await f.invoke("tasks.list", { query: { limit: "ignored-query" } }); assert.equal(listed.statusCode, 200);
  assert.equal((await f.client.invokeOperation("agent:GET:/api/remote-agent/tasks")).statusCode, 200);
  assert.equal(JSON.parse(String(listed.body)).tasks[0].taskId, task.taskId);
  assert.equal(f.api.catalogSnapshot().operations.find(row => row.contract.operationId === "manager.remote-agent.tasks.create")!.contract.recovery.strategy, "inspect-hub-history-no-automatic-replay");
  assert.equal((await f.invoke("disconnect", { body: { deviceId: f.deviceId } })).statusCode, 200);
});

test("task events retain device ownership, returned bytes, terminal repeat behavior and original callbacks", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.connect();
  const result = await f.invoke("tasks.create", { body: { message: "fixture result" } }); const task = JSON.parse(String(result.body)).task;
  const event = { taskId: task.taskId, status: "completed", summary: "fixture complete", device: { deviceId: f.deviceId },
    data: { preserved: [1, false] }, files: [{ name: "result.txt", contentBase64: Buffer.from("returned fixture bytes").toString("base64") }] };
  assert.equal((await f.invoke("task-events.receive", { body: { ...event, device: { deviceId: "another-device" } } })).statusCode, 400);
  const completed = await f.invoke("task-events.receive", { body: event }); assert.equal(completed.statusCode, 202, String(completed.body));
  const saved = JSON.parse(String(completed.body)).task.events.at(-1); assert.equal(await fs.readFile(saved.savedFiles[0].path, "utf8"), "returned fixture bytes");
  assert.equal(saved.files[0].contentBase64, undefined); assert.deepEqual(saved.data, event.data);
  const repeated = await f.invoke("task-events.receive", { body: { ...event, status: "progress", files: [{ name: "must-not-save.txt", contentBase64: "YQ==" }] } });
  assert.equal(repeated.statusCode, 202); assert.equal(JSON.parse(String(repeated.body)).task.status, "completed");
  assert.deepEqual(await fs.readdir(path.dirname(saved.savedFiles[0].path)), ["result.txt"]);
  assert.equal(f.events.length, 1); assert.equal(f.records.filter(record => record.direction === "inbound").length, 1);
});

test("an incorrect inline file digest is rejected before any task or socket dispatch", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.connect();
  const result = await f.invoke("tasks.create", { body: { message: "invalid inline digest", files: [
    { name: "fixture.txt", sha256: "0".repeat(64), contentBase64: Buffer.from("fixture bytes").toString("base64") }
  ] } });
  assert.equal(result.statusCode, 400, String(result.body)); assert.match(String(result.body), /checksum mismatch/);
  assert.deepEqual(f.hub.listTasks(), []); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.wireTasks.length, 0);
});

test("scan cancellation retains the lease until native discovery settles without publishing revoked results", { timeout: 15000 }, async t => {
  const entered = deferred<void>(), release = deferred<Array<{ deviceId: string; deviceName: string; host: string; port: number; controlUrl: string; protocolVersion: number; discoveredAt: string }>>();
  t.after(() => release.resolve([]));
  const f = await fixture(t);
  f.native.discoverRemoteAgents = async () => { entered.resolve(); return release.promise; };
  const controller = new AbortController(); const request = f.invoke("scan", { signal: controller.signal }); await entered.promise;
  controller.abort(); await request; let retired = false; const stopped = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false);
  release.resolve([f.discovered]); await stopped; assert.deepEqual(f.hub.listDevices(), []);
});

test("ABA revocation during HMAC handshake prevents password persistence and waits for socket cleanup", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(); let finish!: () => void;
  f.holdRegistration(callback => { finish = callback; entered.resolve(); });
  assert.equal((await f.invoke("scan")).statusCode, 200);
  const connecting = f.invoke("connect", { body: { deviceId: f.deviceId, password: f.password } }); await entered.promise;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); finish();
  const denied = await connecting; assert.equal(denied.statusCode, 403); assert.equal(await fs.stat(path.join(f.root, "connections.json")).then(() => true, () => false), false);
  assert.equal(f.hub.listDevices().find(row => row.deviceId === f.deviceId)!.connected, false); assert.equal(f.wireTasks.length, 0);
});

test("plugin stop cancels pending authentication and drains actual native callbacks", { timeout: 15000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(); f.holdRegistration(() => entered.resolve());
  await f.invoke("scan"); const connecting = f.invoke("connect", { body: { deviceId: f.deviceId, password: f.password } }); await entered.promise;
  f.hub.stopAccepting(); await f.registration.dispose(); await f.hub.shutdown();
  assert.equal((await connecting).statusCode, 400); assert.equal(await fs.stat(path.join(f.root, "connections.json")).then(() => true, () => false), false);
});

test("Hub shutdown awaits accepted asynchronous callbacks after HTTP completion", { timeout: 15000 }, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  t.after(() => release.resolve());
  const f = await fixture(t); await f.connect();
  f.callback(async () => { entered.resolve(); await release.promise; });
  const created = await f.invoke("tasks.create", { body: { message: "fixture callback lifetime" } });
  const taskId = JSON.parse(String(created.body)).task.taskId;
  assert.equal((await f.invoke("task-events.receive", { body: { taskId, status: "completed", device: { deviceId: f.deviceId } } })).statusCode, 202); await entered.promise;
  let stopped = false; const shutdown = f.hub.shutdown().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release.resolve(); await shutdown; assert.equal(stopped, true);
});

test("native JSON conversions remain explicit for disconnect primitives and discovery NaN values", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const body of [[], false, 0, "no-target"]) {
    const response = await f.invoke("disconnect", { body: typeof body === "string" ? JSON.stringify(body) : body });
    assert.equal(response.statusCode, 200, String(response.body));
  }
  assert.equal((await f.invoke("disconnect", { body: null })).statusCode, 400);
  f.native.discoverRemoteAgents = async () => [{ ...f.discovered, protocolVersion: NaN }];
  const scan = await f.invoke("scan"); assert.equal(scan.statusCode, 200); assert.equal(JSON.parse(String(scan.body)).devices[0].protocolVersion, null);
});
