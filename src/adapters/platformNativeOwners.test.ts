import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createFeishuAdapter as createNativeFeishuAdapter, type FeishuAdapterSettings, type FeishuAdapterDependencies } from "./feishuAdapter.js";
import { createNapCatAdapter as createNativeNapCatAdapter, type NapCatAdapterDependencies } from "./napcatAdapter.js";
import type { MessageAdapterDispose } from "./messageAdapter.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { startNapCatWsOwner } from "./napcatWsOwner.js";
import { apiCatalogOpenApi } from "../manager/apiOperationCatalog.js";
import type { ApiExternalListenerDefinition, ApiExternalListenerPublication } from "../manager/apiExternalListenerBinding.js";

const createFeishuAdapter = (dependencies: FeishuAdapterDependencies = {}) =>
  createNativeFeishuAdapter({ apiOperations: new ManagerPluginRouteRegistry(), ...dependencies });
const createNapCatAdapter = (dependencies: NapCatAdapterDependencies = {}) =>
  createNativeNapCatAdapter({ apiOperations: new ManagerPluginRouteRegistry(), ...dependencies });

const timestamp = 1_700_000_000;
const token = "test-native-verification";
const key = "test-native-encrypt";
const settings = (port = 0): FeishuAdapterSettings => ({ appId: "test-native-app", appSecret: "test-native-secret",
  verificationToken: token, encryptKey: key, eventSubscriptionEnabled: true, webhookPort: port, webhookPath: "/Native//callback/" });
function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function unusedPort() {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); return port;
}
function exchange(port: number, pathname: string, body: Buffer, method = "POST", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method,
      headers: { "content-length": String(body.length), ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", data => chunks.push(Buffer.from(data)));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    }); request.on("error", reject); request.end(body);
  });
}
function body(id = "event-native") {
  return Buffer.from(JSON.stringify({ schema: "2.0", header: { event_id: id, event_type: "im.message.receive_v1", token },
    event: { sender: { sender_id: { open_id: "sender-native" } }, message: { message_id: "message-native", chat_id: "chat-native",
      message_type: "text", content: JSON.stringify({ text: "native raw bytes 测试" }) } } }));
}
function signature(raw: Buffer) {
  const nonce = "nonce-native"; return { "x-lark-request-timestamp": String(timestamp), "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash("sha256").update(String(timestamp)).update(nonce).update(key).update(raw).digest("hex") };
}

test("Feishu external binding executes exact native path, challenge, raw signature, bounds and dispositions", async t => {
  const dataDir = directory(t); const registry = new ManagerPluginRouteRegistry();
  let publication: ApiExternalListenerPublication | undefined; const forwarded: unknown[][] = [];
  const adapter = createFeishuAdapter({ settings, dataDir: () => dataDir, memoryDataDir: () => dataDir,
    now: () => new Date(timestamp * 1000), apiOperations: { registerExternalListener: (definition: ApiExternalListenerDefinition) => registry.registerExternalListener("injected-feishu", definition) }, publishListener: value => { publication = value; },
    forward: (...args) => { forwarded.push(args); } });
  const dispose = await adapter.start() as MessageAdapterDispose; t.after(dispose);
  const published = publication!; const port = published.binding.address.port;
  assert.equal(published.binding.authentication.kind, "native");
  assert.equal(published.binding.invocation, "discovery-only");
  const operation = registry.catalogSnapshot().operations[0]!;
  assert.equal(operation.binding?.leaseId, published.binding.leaseId);
  assert.equal(registry.catalogSnapshot().operations.length, 1);
  assert.equal(JSON.stringify((await apiCatalogOpenApi(registry.catalogSnapshot()))).includes(published.binding.leaseId), true);
  assert.equal(JSON.stringify(published).includes(token), false);
  assert.equal(JSON.stringify(published).includes(key), false);
  const challenge = Buffer.from(JSON.stringify({ type: "url_verification", token, challenge: "native-challenge" }));
  const response = await exchange(port, settings().webhookPath + "?opaque=query", challenge);
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { challenge: "native-challenge" });
  assert.equal((await exchange(port, "/Native/callback/", challenge)).status, 404);
  assert.equal((await exchange(port, "/Native//callback", challenge)).status, 404);
  assert.equal((await exchange(port, settings().webhookPath, Buffer.alloc(0), "GET")).status, 404);
  assert.equal((await exchange(port, settings().webhookPath, Buffer.from("{"))).status, 400);
  assert.equal((await exchange(port, settings().webhookPath, Buffer.from("{}"))).status, 401);
  assert.equal((await exchange(port, settings().webhookPath, Buffer.alloc(1024 * 1024 + 1, 32))).status, 413);
  const raw = body();
  assert.equal((await exchange(port, settings().webhookPath, raw, "POST", { ...signature(raw), "content-type": "application/octet-stream" })).status, 200);
  assert.equal((await exchange(port, settings().webhookPath, raw, "POST", signature(raw))).status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal((forwarded[0]![1] as { identityNamespace: string }).identityNamespace, settings().appId);
  assert.deepEqual(forwarded[0]![2], { feishuChatId: "chat-native", feishuMessageId: "message-native" });
  assert.equal((await exchange(port, settings().webhookPath, Buffer.concat([raw, Buffer.from(" ")]), "POST", signature(raw))).status, 401);
  await dispose(); assert.equal(publication, undefined); assert.equal(registry.catalogSnapshot().operations.length, 0);
});

test("Feishu retirement joins an accepted callback after caller disconnect and concurrent dispose", async t => {
  const dataDir = directory(t); const registry = new ManagerPluginRouteRegistry();
  const entered = deferred(), release = deferred(); let port = 0;
  const adapter = createFeishuAdapter({ settings, dataDir: () => dataDir, memoryDataDir: () => dataDir,
    now: () => new Date(timestamp * 1000), apiOperations: registry,
    publishListener: publication => { if (publication) port = publication.binding.address.port; },
    forward: async () => { entered.resolve(); await release.promise; } });
  const dispose = await adapter.start() as MessageAdapterDispose; t.after(() => { release.resolve(); return dispose(); });
  const raw = body("event-deferred");
  const request = http.request({ host: "127.0.0.1", port, path: settings().webhookPath, method: "POST", headers: signature(raw) });
  request.on("error", () => {}); request.end(raw); await entered.promise; request.destroy();
  const first = dispose() as Promise<void>, second = dispose() as Promise<void>;
  assert.equal(first, second); let completed = false; void second.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(completed, false);
  release.resolve(); await second; assert.equal(completed, true);
});

test("NapCat native reverse WS retains arbitrary paths, text/binary frames, instance identity and callback leases", async t => {
  const dataDir = directory(t); const port = await unusedPort(); const registry = new ManagerPluginRouteRegistry();
  const entered = deferred(), release = deferred(), secondFrame = deferred();
  const events: Array<{ id?: number | string; instance: string; binary: boolean; signal: AbortSignal }> = [];
  let publication: ApiExternalListenerPublication | undefined;
  const adapter = createNapCatAdapter({ instances: () => [{ id: "instance-a", name: "Native WS", enabled: true,
    autoLoginOnRabiStart: false, gatewayPort: port, httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1", accessToken: "test-outbound-only" /* Public test-only fixture; not a real credential. */ }],
    dataDir: () => dataDir, apiOperations: { registerExternalListener: (definition: ApiExternalListenerDefinition) => registry.registerExternalListener("injected-napcat", definition) }, refreshProfile: () => {}, publishListener: (_instance, value) => { publication = value; },
    handleEvent: async (event, instance, frame) => {
      events.push({ id: event.message_id, instance: instance.id, binary: frame.isBinary, signal: frame.signal });
      if (event.message_id === "first") { entered.resolve(); await release.promise; } else secondFrame.resolve();
    } });
  const dispose = await adapter.start() as MessageAdapterDispose; t.after(() => { release.resolve(); return dispose(); });
  assert.equal(publication!.binding.authentication.kind, "none");
  assert.equal(publication!.binding.invocation, "discovery-only");
  assert.equal(publication!.binding.address.hostname, "127.0.0.1");
  assert.equal(JSON.stringify(publication).includes("test-outbound-only"), false);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/any//path/%2F?opaque=1`); await once(socket, "open");
  socket.send(JSON.stringify({ message_id: "first", post_type: "message", message_type: "group" })); await entered.promise;
  socket.send(Buffer.from(JSON.stringify({ message_id: "second", post_type: "message", message_type: "private" }))); await secondFrame.promise;
  socket.send("{");
  const first = dispose() as Promise<void>, second = dispose() as Promise<void>; assert.equal(first, second);
  let finished = false; void second.then(() => { finished = true; });
  await once(socket, "close"); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
  assert.equal(events[0]!.signal.aborted, true); assert.deepEqual(events.map(({ id, instance, binary }) => ({ id, instance, binary })), [
    { id: "first", instance: "instance-a", binary: false }, { id: "second", instance: "instance-a", binary: true }]);
  release.resolve(); await second; assert.equal(publication, undefined); assert.equal(registry.catalogSnapshot().operations.length, 0);
});

test("NapCat native handshake failure preserves ws status and close waits for startup profile", async t => {
  const dataDir = directory(t); const port = await unusedPort(); const entered = deferred(), release = deferred();
  const adapter = createNapCatAdapter({ instances: () => [{ id: "native", name: "Native handshake", enabled: true,
    autoLoginOnRabiStart: false, gatewayPort: port, httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1", accessToken: "" }],
    dataDir: () => dataDir, refreshProfile: async () => { entered.resolve(); await release.promise; } });
  const dispose = await adapter.start() as MessageAdapterDispose; t.after(() => { release.resolve(); return dispose(); }); await entered.promise;
  assert.equal((await exchange(port, "/native", Buffer.alloc(0), "GET")).status, 426);
  const nativeFailure = await exchange(port, "/arbitrary", Buffer.alloc(0), "GET", { connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "12" });
  assert.equal(nativeFailure.status, 400); assert.equal(nativeFailure.body, "Missing or invalid Sec-WebSocket-Version header");
  let finished = false; const stopping = Promise.resolve(dispose()).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
  release.resolve(); await stopping;
});

test("two Feishu addresses and repeated NapCat instance names publish distinct executable identities", async t => {
  const dataDir = directory(t), registry = new ManagerPluginRouteRegistry(); const disposers: MessageAdapterDispose[] = [];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  for (let index = 0; index < 2; index++) {
    const root = path.join(dataDir, String(index)); fs.mkdirSync(root);
    disposers.push(await createFeishuAdapter({ settings, dataDir: () => root, memoryDataDir: () => root, apiOperations: registry }).start() as MessageAdapterDispose);
    disposers.push(await createNapCatAdapter({ dataDir: () => root, apiOperations: registry, refreshProfile: () => {}, createServer: options => new WebSocketServer(options),
      instances: () => [{ id: "default", name: "Native duplicate name", enabled: true, autoLoginOnRabiStart: false, gatewayPort: 0,
        httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1", accessToken: "" }] }).start() as MessageAdapterDispose);
  }
  const operations = registry.catalogSnapshot().operations;
  assert.equal(operations.length, 4); assert.equal(new Set(operations.map(value => value.contract.operationId)).size, 4);
  assert.equal(new Set(operations.map(value => value.binding!.leaseId)).size, 4);
});

test("trusted publication source describes the same executing native listener and retires with it", async t => {
  const dataDir = directory(t), manager = new ManagerPluginRouteRegistry();
  let publications: ApiExternalListenerPublication[] = [], current = true;
  const remove = manager.registerExternalListenerSource("trusted-gateway-worker", { isCurrent: () => current, read: () => publications });
  t.after(remove);
  const dispose = await createFeishuAdapter({ settings, dataDir: () => dataDir, memoryDataDir: () => dataDir,
    now: () => new Date(timestamp * 1000), publishListener: value => { publications = value ? [value] : []; } }).start() as MessageAdapterDispose;
  t.after(dispose);
  const operation = manager.catalogSnapshot().operations[0]!;
  assert.equal(operation.owner.instanceId, "trusted-gateway-worker");
  assert.equal(operation.binding!.leaseId, publications[0]!.binding.leaseId);
  const challenge = Buffer.from(JSON.stringify({ type: "url_verification", token, challenge: "trusted-worker" }));
  assert.equal((await exchange(operation.binding!.address.port, settings().webhookPath, challenge)).status, 200);
  current = false; assert.equal(manager.catalogSnapshot().operations.length, 0);
  current = true; assert.equal(manager.catalogSnapshot().operations.length, 1);
  await dispose(); assert.equal(manager.catalogSnapshot().operations.length, 0);
});

test("native listener publication failures roll back real listeners and executable bindings", async t => {
  const dataDir = directory(t), registry = new ManagerPluginRouteRegistry();
  const feishuPort = await unusedPort(), napcatPort = await unusedPort();
  const unavailable = () => { throw new Error("test publication unavailable"); };
  await assert.rejects(async () => { await createFeishuAdapter({ settings: () => settings(feishuPort), dataDir: () => dataDir,
    apiOperations: registry, publishListener: unavailable }).start(); }, /test publication unavailable/);
  await assert.rejects(async () => { await createNapCatAdapter({ dataDir: () => dataDir, apiOperations: registry,
    refreshProfile: () => {}, publishListener: unavailable, instances: () => [{ id: "failing", name: "Native failing publication",
      enabled: true, autoLoginOnRabiStart: false, gatewayPort: napcatPort, httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1", accessToken: "" }] }).start(); }, /test publication unavailable/);
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  for (const port of [feishuPort, napcatPort]) {
    const server = net.createServer(); server.listen(port, "127.0.0.1"); await once(server, "listening");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("Feishu failed startup reports both errors after releasing its actual listener", { timeout: 10000 }, async t => {
  const dataDir = directory(t), registry = new ManagerPluginRouteRegistry(), port = await unusedPort();
  const original = new Error("controlled startup failure"), cleanup = new Error("controlled cleanup failure");
  await assert.rejects(async () => createFeishuAdapter({ settings: () => settings(port), dataDir: () => dataDir,
    apiOperations: { registerExternalListener: (definition: ApiExternalListenerDefinition) => {
      const binding = registry.registerExternalListener("feishu-cleanup-failure", definition);
      return { ...binding, dispose: async () => { await binding.dispose(); throw cleanup; } };
    } }, publishListener: publication => { if (publication) throw original; }
  }).start(), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup);
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  const listener = net.createServer(); listener.listen(port, "127.0.0.1"); await once(listener, "listening");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
});

test("NapCat failed binding cleanup still joins an accepted background task", async t => {
  const registry = new ManagerPluginRouteRegistry(), entered = deferred(), release = deferred();
  const cleanupError = new Error("controlled binding cleanup failure");
  let releaseBinding: (() => void | Promise<void>) | undefined;
  const owner = await startNapCatWsOwner({ instanceId: "cleanup-failure", port: 0,
    server: new WebSocketServer({ noServer: true }), reportError: () => {}, connected: () => async () => {},
    operations: { registerExternalListener: (definition: ApiExternalListenerDefinition) => {
      const binding = registry.registerExternalListener("napcat-cleanup-failure", definition);
      releaseBinding = () => binding.dispose();
      return { ...binding, dispose: async () => { throw cleanupError; } };
    } }
  });
  t.after(async () => { release.resolve(); await owner.close().catch(() => {}); await releaseBinding?.(); });
  const work = owner.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const closed = owner.close().then(() => { settled = true; throw new Error("cleanup must fail"); }, error => { settled = true; assert.equal(error, cleanupError); });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, "the original task must finish before cleanup failure is returned");
  release.resolve();
  await Promise.all([closed, work]);
  assert.equal(settled, true);
  assert.equal(owner.listener.listening, false);
});
