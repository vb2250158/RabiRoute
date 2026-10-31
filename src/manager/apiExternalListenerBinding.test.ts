import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import type { ApiOperationContract } from "./apiOperationContract.js";
import type { ApiExternalListenerDefinition } from "./apiExternalListenerBinding.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";

const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" };
const empty = { type: "object", properties: {}, additionalProperties: false } as const;
const listener = (listenerId: string, port: number, extra: Partial<ApiExternalListenerDefinition> = {}): ApiExternalListenerDefinition => ({
  listenerId, address: { protocol: "http", hostname: "127.0.0.1", port }, protocol: "fixture-native", invocation: "native",
  authentication: { kind: "none", description: "Original native listener admission." }, ...extra
});
const raw = (operationId: string): ApiOperationContract => fixtureApiContract({ operationId, pathTemplate: "/callback",
  request: { path: empty, query: true, headers: true, body: { kind: "passthrough" } },
  httpProxy: { wire: { dataFrameBytes: 1024, streamWindowBytes: 4096, maxConcurrentStreams: 2 }, completion: "Native response ends.", cancellation: "Caller disconnect closes native request." },
  responses: { default: { mediaType: "*/*", passthrough: true } }
});
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server: http.Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function manager(registry: ManagerPluginRouteRegistry) {
  const registration = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-node");
    const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity,
      health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return { origin, client: createManagerClient({ managerUrl: origin, credential: "fixture-node", fetchImpl: (url, options) => {
    assert.equal(new URL(url instanceof Request ? url.url : url).origin, origin, "Generic native HTTP must use only the established Manager connection."); return fetch(url, options);
  } }),
    async dispose() { await registration.dispose(); await close(server); } };
}

test("external native HTTP discovery selects the original owner, preserves opaque bytes and never sends node credentials", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const gateway = new ManagerPluginRouteRegistry();
  let lease: ReturnType<typeof gateway.registerExternalListener>;
  let received = Buffer.alloc(0), headers: http.IncomingHttpHeaders = {};
  const native = http.createServer((request, response) => { if (!lease.handle(request, new URL(request.url!, "http://native"), response)) response.writeHead(404).end(); });
  const port = await listen(native);
  lease = gateway.registerExternalListener("gateway", listener("fixture.http", port));
  lease.registerHttpProxies([{ contract: raw("fixture.native"), async handler(input) {
    headers = input.request.headers;
    const chunks: Buffer[] = []; for await (const bytes of input.request) chunks.push(Buffer.from(bytes)); received = Buffer.concat(chunks);
    input.prepareResponse(201, { "content-type": "text/plain" }); input.response.writeHead(201, { "content-type": "text/plain" });
    input.response.end(received.toString("utf8"));
  } }]);
  let replyUrl = "";
  lease.registerHttpProxies([{ contract: { ...raw("fixture.native.replies"), method: "GET", pathTemplate: "/rabilink//replies" }, async handler(input) {
    replyUrl = input.request.url!; input.prepareResponse(200, {}); input.response.end("native-replies");
  } }]);
  let current = true;
  const remove = registry.registerExternalListenerSource("gateway-process", { isCurrent: () => current, read: () => [lease.publication()] });
  const transport = await manager(registry);
  t.after(async () => { remove(); await lease.dispose(); await transport.dispose(); await close(native); });
  const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
  const result = await transport.client.invokeOperation("fixture.native", { bodyBytes: bytes, query: { unknown: "kept" }, headers: { "content-type": "application/x-native" } });
  assert.equal(result.statusCode, 201); assert.equal(result.body, bytes.toString("utf8")); assert.equal(result.uncertain, false);
  assert.deepEqual(received, bytes); assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
  assert.equal(headers["x-rabiroute-agent-type"], undefined); assert.equal(headers["x-rabiroute-expected-manager-instance-id"], undefined);
  assert.equal(headers["x-rabiroute-listener-lease"], lease.binding.leaseId);
  const replies = await transport.client.invokeOperation("fixture.native.replies", { query: { unknown: "kept" } });
  assert.equal(replies.body, "native-replies"); assert.equal(replyUrl, "/rabilink//replies?unknown=kept");
  assert.equal(replies.headers!["content-type"], undefined);
  assert.equal(registry.catalogSnapshot().operations.find(value => value.contract.operationId === "fixture.native")!.binding!.address.port, port);
  current = false;
  assert.equal(registry.catalogSnapshot().operations.some(value => value.contract.operationId === "fixture.native"), false);
  await assert.rejects(transport.client.invokeOperation("fixture.native", { body: {} }), /absent from current discovery/);
});

test("native Authorization has a separate explicit credential boundary and never inherits the Manager bearer", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  let lease!: ReturnType<typeof registry.registerExternalListener>, seen = "";
  const native = http.createServer((request, response) => lease.handle(request, new URL(request.url!, "http://native"), response));
  const port = await listen(native);
  lease = registry.registerExternalListener("native-auth-owner", listener("fixture.auth", port, { authentication: { kind: "native", description: "Original Authorization credential." } }));
  lease.registerHttpProxies([{ contract: raw("fixture.auth.operation"), async handler(input) {
    seen = String(input.request.headers.authorization ?? ""); const status = seen === "Bearer fixture-native" ? 200 : 401;
    input.request.resume(); input.prepareResponse(status, {}); input.response.writeHead(status).end("native-auth");
  } }]);
  const transport = await manager(registry), client = createManagerClient({ managerUrl: transport.origin, credential: "fixture-node" });
  t.after(async () => { await lease.dispose(); await transport.dispose(); await close(native); });
  assert.equal((await client.invokeOperation("fixture.auth.operation", { bodyText: "body" })).statusCode, 401); assert.equal(seen, "");
  assert.equal((await client.invokeOperation("fixture.auth.operation", { bodyText: "body", nativeHeaders: { Authorization: "Bearer fixture-native" } })).statusCode, 200);
  assert.equal(seen, "Bearer fixture-native");
  await assert.rejects(client.invokeOperation("fixture.auth.operation", { bodyText: "body", nativeHeaders: { Authorization: "Bearer fixture-node" } }), /cannot be reused/);
});

test("Manager and independent listeners keep separate method/path spaces and OpenAPI projections", async () => {
  const registry = new ManagerPluginRouteRegistry();
  const a = registry.registerExternalListener("owner-a", listener("listener.a", 12341));
  const b = registry.registerExternalListener("owner-b", listener("listener.b", 12342));
  const definition = (operationId: string) => ({ contract: fixtureApiContract({ operationId }), handler: () => ({ status: 200, body: { ok: true, value: 1 } }) });
  const main = registry.registerOperations("manager-owner", [definition("manager.operation")]);
  a.registerOperations([definition("a.operation")]); b.registerOperations([definition("b.operation")]);
  assert.throws(() => b.registerOperations([definition("a.operation")]), /another address space/);
  assert.throws(() => registry.registerOperations("duplicate", [definition("b.operation")]), /another address space/);
  const document = (await apiCatalogOpenApi(registry.catalogSnapshot())) as any;
  assert.equal(document.paths["/api/example/records/{recordId}"].post.operationId, "manager.operation");
  assert.equal(document["x-rabiroute-external-listeners"].length, 2);
  assert.deepEqual(document["x-rabiroute-external-listeners"].map((item: any) => item.paths["/api/example/records/{recordId}"].post.operationId).sort(), ["a.operation", "b.operation"]);
  const before = registry.catalogSnapshot(); a.stopAccepting(); const after = registry.catalogSnapshot();
  assert.notEqual(before.etag, after.etag); assert.equal(after.operations.some(value => value.contract.operationId === "a.operation"), false);
  await Promise.all([a.dispose(), b.dispose(), main.dispose()]);
});

test("stale native leases fail before handlers while legacy requests retain original native admission", async t => {
  const registry = new ManagerPluginRouteRegistry(); let lease: ReturnType<typeof registry.registerExternalListener>, calls = 0;
  const server = http.createServer((request, response) => lease.handle(request, new URL(request.url!, "http://native"), response));
  const port = await listen(server); lease = registry.registerExternalListener("owner", listener("fixture.lease", port));
  lease.registerHttpProxies([{ contract: raw("fixture.lease.operation"), async handler(input) {
    calls++; input.prepareResponse(200, {}); input.response.end("native");
  } }]);
  t.after(async () => { await lease.dispose(); await close(server); });
  const url = `http://127.0.0.1:${port}/callback`;
  assert.equal((await fetch(url, { method: "POST", headers: { "x-rabiroute-listener-lease": "retired" } })).status, 409);
  assert.equal(calls, 0);
  const legacy = await fetch(url, { method: "POST" }); assert.equal(await legacy.text(), "native"); assert.equal(calls, 1);
  lease.stopAccepting(); assert.equal((await fetch(url, { method: "POST" })).status, 409); assert.equal(calls, 1);
});

test("external native WebSocket uses its original upgrade owner without node bearer and joins retirement", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  let lease: ReturnType<typeof registry.registerExternalListener>, nativeHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer(); const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => { if (!lease.handleUpgrade(request, new URL(request.url!, "http://native"), socket, head)) socket.destroy(); });
  const port = await listen(server); lease = registry.registerExternalListener("native.ws.owner", listener("fixture.ws", port));
  const contract = fixtureApiContract({ operationId: "fixture.ws.echo", method: "GET", pathTemplate: "/native-ws", transport: "websocket",
    request: { path: empty, query: empty, headers: true, body: { kind: "none" } }, responses: { "101": { mediaType: "application/octet-stream", schema: false } },
    websocket: { protocol: "fixture-echo", framing: "bytes", maxMessageBytes: 4096, maxBufferedBytes: 8192,
      authentication: "Native listener admission.", completion: "Original socket closes.", cancellation: "Close original socket." } });
  lease.registerUpgrades([{ contract, handler(input) {
    nativeHeaders = input.request.headers; input.prepareHandshake({});
    wss.handleUpgrade(input.request, input.socket, Buffer.from(input.head), socket => {
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      input.accept({ closed, close: () => socket.close() });
      socket.on("message", data => socket.send(data));
    });
  } }]);
  const transport = await manager(registry);
  t.after(async () => { await lease.dispose(); await transport.dispose(); wss.close(); await close(server); });
  let resolve!: (value: unknown) => void; const echoed = new Promise(done => { resolve = done; });
  const socket = await transport.client.openOperation("fixture.ws.echo", { onMessage: value => { resolve(value); }, onOpen: connection => { connection.send(Buffer.from("native-frame")); } });
  assert.equal(Buffer.from(await echoed as Uint8Array).toString(), "native-frame");
  assert.equal(nativeHeaders.authorization, undefined); assert.equal(nativeHeaders["x-rabiroute-listener-lease"], lease.binding.leaseId);
  await lease.dispose(); await socket.closed; assert.equal(lease.activeOperationCount(), 0);
});

test("external protocol discovery never masquerades as a node-authenticated business call", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const lease = registry.registerExternalListener("platform", listener("fixture.platform", 12349, { invocation: "discovery-only", protocol: "signed-callback", authentication: { kind: "native", description: "Platform signature and challenge." } }));
  lease.registerHttpProxies([{ contract: raw("platform.callback"), async handler() { throw new Error("must not be called"); } }]);
  const transport = await manager(registry); t.after(async () => { await lease.dispose(); await transport.dispose(); });
  await assert.rejects(transport.client.invokeOperation("platform.callback", { body: {} }), /requires its native protocol connector and authentication/);
});

test("external sources fail closed on forged contracts and binding secrets without hiding coverage gaps", async () => {
  const gateway = new ManagerPluginRouteRegistry(), registry = new ManagerPluginRouteRegistry();
  const lease = gateway.registerExternalListener("owner", listener("fixture.source", 12345));
  lease.registerHttpProxies([{ contract: raw("fixture.source.operation"), handler: async () => {} }]);
  const publication = lease.publication();
  const stop = registry.registerExternalListenerSource("gateway", { isCurrent: () => true, read: () => [{ ...publication,
    operations: publication.operations.map(operation => ({ ...operation, contractDigest: "sha256:forged" })) }] });
  assert.equal(registry.catalogSnapshot().operations.length, 0); assert.equal(registry.catalogSnapshot().coverage.complete, false); stop();
  assert.throws(() => gateway.registerExternalListener("leak", { ...listener("fixture.secret", 12346), authentication: { kind: "native", description: "native", token: "not-a-real-secret" } } as any), /cannot publish credentials/);
  await lease.dispose();
});

test("one invalid listener cannot hide valid siblings and cached partial coverage stays explicit", async t => {
  const gateway = new ManagerPluginRouteRegistry(), registry = new ManagerPluginRouteRegistry();
  const leases = [0, 1, 2].map(index => gateway.registerExternalListener("fixture", listener(`fixture.partial.${index}`, 12350 + index)));
  for (const [index, lease] of leases.entries()) lease.registerHttpProxies([{ contract: raw(`fixture.partial.operation.${index}`), handler: async () => {} }]);
  const complete = leases.map(lease => lease.publication());
  let publications = complete;
  const stop = registry.registerExternalListenerSource("gateway-partial", { isCurrent: () => true, read: () => publications });
  t.after(async () => { stop(); await Promise.all(leases.map(lease => lease.dispose())); await registry.disposeNativeListenerHttp(); });
  const cyclic: any = { ...complete[1] }; cyclic.self = cyclic;
  const unreadable = { get active(): boolean { throw new Error("controlled unreadable publication"); } };
  for (const invalid of [undefined, cyclic, unreadable, null, { ...complete[1], binding: { ...complete[1]!.binding, address: { ...complete[1]!.binding.address, port: 0 } } },
    { ...complete[1], operations: complete[1]!.operations.map(operation => ({ ...operation, contractDigest: "forged" })) }]) {
    publications = [complete[0]!, invalid as any, complete[2]!];
    for (let read = 0; read < 2; read++) {
      const snapshot = registry.catalogSnapshot();
      assert.deepEqual(snapshot.listeners.map(item => item.binding.listenerId), ["fixture.partial.0", "fixture.partial.2"]);
      assert.equal(snapshot.operations.length, 2); assert.equal(snapshot.coverage.gaps.length, 1);
      assert.equal(snapshot.coverage.complete, false);
    }
  }
  publications = [complete[0]!, cyclic, complete[2]!];
  assert.equal(registry.catalogSnapshot().listeners.length, 2);
  cyclic.binding = complete[0]!.binding;
  assert.deepEqual(registry.catalogSnapshot().listeners.map(item => item.binding.listenerId), ["fixture.partial.2"], "a changed invalid neighbor identity invalidates cached duplicate admission");
  cyclic.binding = complete[1]!.binding;
  assert.equal(registry.catalogSnapshot().listeners.length, 2);
  publications = [complete[0]!, complete[0]!, complete[2]!];
  assert.deepEqual(registry.catalogSnapshot().listeners.map(item => item.binding.listenerId), ["fixture.partial.2"], "both ambiguous identities are excluded locally");
  publications = complete;
  assert.equal(registry.catalogSnapshot().listeners.length, 3); assert.equal(registry.catalogSnapshot().coverage.complete, true);
  const failingSource = registry.registerExternalListenerSource("unavailable-gateway", { isCurrent: () => true, read: () => { throw new Error("synthetic source unavailable"); } });
  assert.equal(registry.catalogSnapshot().listeners.length, 3); assert.equal(registry.catalogSnapshot().coverage.gaps.length, 1);
  failingSource();
});

test("internal transport controls remain in the explicit listener inventory without becoming public business operations", async () => {
  const owner = new ManagerPluginRouteRegistry(), manager = new ManagerPluginRouteRegistry();
  const lease = owner.registerExternalListener("transport-owner", listener("fixture.transport", 12348, { invocation: "discovery-only", protocol: "native-control" }));
  lease.registerHttpProxies([{ contract: { ...raw("fixture.internal.control"), exposure: "internal" }, handler: async () => {} }]);
  const unregister = manager.registerExternalListenerSource("transport-runtime", { isCurrent: () => true, read: () => [lease.publication()] });
  const snapshot = manager.catalogSnapshot();
  assert.equal(snapshot.operations.length, 0); assert.equal(snapshot.listeners.length, 1);
  const document = (await apiCatalogOpenApi(snapshot)) as any;
  assert.equal(document["x-rabiroute-external-listeners"][0].binding.protocol, "native-control");
  assert.deepEqual(document["x-rabiroute-external-listeners"][0].paths, {});
  lease.stopAccepting(); assert.equal(manager.catalogSnapshot().listeners.length, 0);
  unregister(); assert.equal(manager.catalogSnapshot().listeners.length, 0); await lease.dispose();
});

test("projection metadata changes owner while retaining the same original native transport lease and access digest", async () => {
  const gateway = new ManagerPluginRouteRegistry(), published = new Set(["old"]);
  const manager = new ManagerPluginRouteRegistry(() => published, { identity: () => identity });
  const lease = gateway.registerExternalListener("original-gateway", listener("fixture.projected", 12347));
  lease.registerHttpProxies([{ contract: raw("fixture.projected.operation"), handler: async () => {} }]);
  const plugin: PluginIdentity = { ...identity, activationId: "old", pluginId: "gateway-runtime", instanceId: "gateway-runtime", host: "manager", version: "1.0.0", revision: "old" };
  const source = { isCurrent: () => true, read: () => [lease.publication()] };
  const old = runPluginActivation(plugin, () => manager.registerExternalListenerSource("gateway:fixture", source));
  const before = manager.catalogSnapshot().operations[0]!;
  const next = runPluginActivation({ ...plugin, activationId: "next", revision: "next" }, () => manager.registerExternalListenerSource("gateway:fixture", source));
  assert.equal(manager.catalogSnapshot().operations[0]!.owner.activationId, "old");
  published.add("next");
  const after = manager.catalogSnapshot().operations[0]!;
  assert.equal(after.owner.activationId, "next"); assert.deepEqual(after.binding, before.binding); assert.deepEqual(after.access, before.access);
  await manager.drainRetiredNativeListenerHttp();
  published.delete("next"); assert.equal(manager.catalogSnapshot().operations[0]!.owner.activationId, "old");
  next(); old(); manager.refreshPublication(); await manager.drainRetiredNativeListenerHttp(); await lease.dispose();
});

test("a native address generation change after a write is uncertain without replay and the next call rediscovers its owner", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const gatewayA = new ManagerPluginRouteRegistry(), gatewayB = new ManagerPluginRouteRegistry();
  let first!: ReturnType<typeof gatewayA.registerExternalListener>, second!: ReturnType<typeof gatewayB.registerExternalListener>;
  const serverA = http.createServer((request, response) => first.handle(request, new URL(request.url!, "http://native"), response));
  const serverB = http.createServer((request, response) => second.handle(request, new URL(request.url!, "http://native"), response));
  const portA = await listen(serverA), portB = await listen(serverB);
  first = gatewayA.registerExternalListener("native-owner", listener("fixture.moving", portA));
  second = gatewayB.registerExternalListener("native-owner", listener("fixture.moving", portB));
  let firstCalls = 0, secondCalls = 0;
  let published: ReturnType<typeof first.publication>;
  first.registerHttpProxies([{ contract: raw("fixture.moving.operation"), async handler(input) {
    firstCalls++; input.request.resume(); published = second.publication();
    input.prepareResponse(200, { "content-type": "text/plain" }); input.response.writeHead(200, { "content-type": "text/plain" }).end("first");
  } }]);
  second.registerHttpProxies([{ contract: raw("fixture.moving.operation"), async handler(input) {
    secondCalls++; input.request.resume(); input.prepareResponse(200, { "content-type": "text/plain" });
    input.response.writeHead(200, { "content-type": "text/plain" }).end("second");
  } }]);
  published = first.publication();
  const remove = registry.registerExternalListenerSource("gateway-process", { isCurrent: () => true, read: () => [published] });
  const transport = await manager(registry);
  t.after(async () => { remove(); await Promise.all([first.dispose(), second.dispose()]); await transport.dispose(); await close(serverA); await close(serverB); });
  const receipt = await transport.client.invokeOperation("fixture.moving.operation", { body: { value: 1 }, headers: { "idempotency-key": "original-key" } });
  assert.equal(receipt.ok, false); assert.equal(receipt.uncertain, true); assert.equal(receipt.bindingChanged, true); assert.equal(receipt.noReplay, true);
  assert.equal(firstCalls, 1); assert.equal(secondCalls, 0);
  const next = await transport.client.invokeOperation("fixture.moving.operation", { body: { value: 2 } });
  assert.equal(next.body, "second"); assert.equal(next.uncertain, false); assert.equal(secondCalls, 1); assert.equal(firstCalls, 1);
});
