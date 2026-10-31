import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { TunnelChannel } from "../peerTunnel/channel.js";
import { loadTunnelIdentity } from "../peerTunnel/security.js";
import { establishTunnel } from "../peerTunnel/session.js";
import { serveTunnel, tunnelFetch } from "../peerTunnel/http.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";

test("generic external native HTTP crosses an established encrypted Manager tunnel without native-port access or credential leakage", { timeout: 10000 }, async t => {
  const a = new EventEmitter() as TunnelChannel, b = new EventEmitter() as TunnelChannel;
  let channelClosed = false;
  a.send = async bytes => { setImmediate(() => { if (!channelClosed) b.emit("data", Buffer.from(bytes)); }); };
  b.send = async bytes => { setImmediate(() => { if (!channelClosed) a.emit("data", Buffer.from(bytes)); }); };
  a.close = b.close = () => { if (channelClosed) return; channelClosed = true; a.emit("close"); b.emit("close"); };
  const first = loadTunnelIdentity(path.join(os.tmpdir(), randomUUID() + ".json"), "fixture-caller", "fixture-generation", { persist: false });
  const second = loadTunnelIdentity(path.join(os.tmpdir(), randomUUID() + ".json"), "fixture-receiver", "fixture-generation", { persist: false });
  const [caller, receiver] = await Promise.all([
    establishTunnel(a, first, { deviceId: second.deviceId, publicKey: second.publicKey, services: ["manager"] }, true, AbortSignal.timeout(5000)),
    establishTunnel(b, second, { deviceId: first.deviceId, publicKey: first.publicKey, services: ["manager"] }, false, AbortSignal.timeout(5000))
  ]);
  t.after(async () => { await Promise.all([caller.close(), receiver.close()]); });
  const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity }), gateway = new ManagerPluginRouteRegistry();
  let lease!: ReturnType<typeof gateway.registerExternalListener>, nativeCalls = 0;
  const native = http.createServer((request, response) => lease.handle(request, new URL(request.url!, "http://native"), response));
  native.listen(0, "127.0.0.1"); await once(native, "listening");
  lease = gateway.registerExternalListener("original-gateway", { listenerId: "fixture.encrypted.native", address: { protocol: "http", hostname: "127.0.0.1", port: (native.address() as { port: number }).port },
    protocol: "fixture-opaque", invocation: "native", authentication: { kind: "none", description: "Original native owner." } });
  const contract = fixtureApiContract({ operationId: "fixture.encrypted.operation", pathTemplate: "/native//message", request: { path: true, query: true, headers: true, body: { kind: "passthrough" } },
    httpProxy: { wire: { dataFrameBytes: 1024, streamWindowBytes: 4096, maxConcurrentStreams: 2 }, completion: "Original response closes.", cancellation: "Close original response." }, responses: { default: { mediaType: "*/*", passthrough: true } } });
  lease.registerHttpProxies([{ contract, async handler(input) {
    nativeCalls++; assert.equal(input.request.headers.authorization, undefined); assert.equal(input.request.headers.cookie, undefined);
    assert.equal(input.request.headers["x-rabiroute-agent-id"], undefined); assert.equal(input.request.headers["x-rabiroute-expected-manager-instance-id"], undefined);
    const chunks: Buffer[] = []; for await (const bytes of input.request) chunks.push(Buffer.from(bytes));
    input.prepareResponse(206, { "content-type": "application/octet-stream" }); input.response.writeHead(206, { "content-type": "application/octet-stream" }).end(Buffer.concat(chunks));
  } }]);
  let current = true;
  const remove = registry.registerExternalListenerSource("original-gateway", { isCurrent: () => current, read: () => [lease.publication()] });
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const manager = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-node"); const url = new URL(request.url!, "http://manager");
    if (url.pathname === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  manager.listen(0, "127.0.0.1"); await once(manager, "listening");
  const managerOrigin = `http://127.0.0.1:${(manager.address() as { port: number }).port}`;
  serveTunnel(receiver, () => ({ manager: { baseUrl: managerOrigin, headers: { authorization: "Bearer fixture-node" } } }));
  t.after(async () => { remove(); await lease.dispose(); await discovery.dispose(); manager.closeAllConnections(); native.closeAllConnections(); await Promise.all([new Promise<void>(resolve => manager.close(() => resolve())), new Promise<void>(resolve => native.close(() => resolve()))]); });
  const calls: string[] = [];
  const client = createManagerClient({ managerUrl: "http://receiver.invalid", credential: "fixture-node", fetchImpl: async (url, options) => {
    const target = new URL(url instanceof Request ? url.url : url); assert.equal(target.origin, "http://receiver.invalid"); calls.push(target.pathname);
    return tunnelFetch(caller, "manager", target.pathname + target.search, options);
  } });
  const bytes = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
  const helpReceipt = await client.request("GET", "/api/agent/help");
  assert.equal(helpReceipt.ok, true, JSON.stringify({ statusCode: helpReceipt.statusCode, identityChanged: helpReceipt.identityChanged, uncertain: helpReceipt.uncertain, bytesReceived: helpReceipt.bytesReceived }));
  const receipt = await client.invokeOperation(contract.operationId, { bodyBytes: bytes, responseMode: "bytes", headers: { "idempotency-key": "original-native-write" } });
  assert.equal(receipt.statusCode, 206); assert.equal(receipt.uncertain, false); assert.deepEqual(Buffer.from(receipt.bodyBytes!), bytes); assert.equal(nativeCalls, 1);
  assert.equal(calls.some(target => target.startsWith("/api/native-listeners/")), true);
  current = false;
  await assert.rejects(client.invokeOperation(contract.operationId, { bodyBytes: bytes }), /absent from current discovery/); assert.equal(nativeCalls, 1);
});
