import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { PeerLanServer } from "./peerLanServer.js";
import { createPeerLanListenerMetadata, type PeerLanListenerMetadataContext } from "./peerLanListenerMetadata.js";
import { createManagerApiOperationsService, ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import { PEER_RPC_PATH } from "../rabiPeerProtocol.js";

const identity = (activationId: string): PluginIdentity => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager",
  activationId, instanceId: "manager:rabilink-relay", pluginId: "io.rabiroute.manager.rabilink-relay", version: "1.0.0", revision: activationId, host: "manager" });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const published = new Set<string>(), owners: ReturnType<typeof createPeerLanListenerMetadata>[] = [], errors: unknown[] = [];
  let calls = 0;
  const server = new PeerLanServer({ host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"],
    peerHandler: (_request, _url, response) => { calls++; response.writeHead(400).end("original-peer-owner"); return true; } });
  const registry = new ManagerPluginRouteRegistry(() => published, { identity: () => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" }) });
  const operations = createManagerApiOperationsService(registry);
  const make = (activation: PluginIdentity, override: Partial<PeerLanListenerMetadataContext> = {}) => {
    const owner = createPeerLanListenerMetadata({ identity: activation, server, operations,
      refresh: () => { registry.refreshPublication(); }, reportError: error => { errors.push(error); }, ...override });
    owners.push(owner); return owner;
  };
  t.after(async () => { await Promise.allSettled(owners.map(owner => owner.stop())); await server.stop(); });
  const native = () => {
    const address = server.boundAddress(); if (!address) throw new Error("Original Peer listener is not bound.");
    return new Promise<{ status: number; text(): Promise<string> }>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${address.port}${PEER_RPC_PATH}`, { method: "POST", headers: { connection: "close" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, text: async () => Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject); request.end("controlled-invalid-peer-packet");
    });
  };
  return { server, registry, published, make, operations, errors, native, calls: () => calls };
}

test("published metadata describes the actual existing Peer listener with no public business operations or replacement dispatcher", async t => {
  const f = await fixture(t), active = identity("active"), owner = f.make(active);
  assert.equal(f.registry.catalogSnapshot().listeners.length, 0);
  await f.server.start();
  assert.equal(f.registry.catalogSnapshot().listeners.length, 0, "prepared helper does not publish or observe a candidate");
  f.published.add(active.activationId); owner.start();
  const snapshot = f.registry.catalogSnapshot(), metadata = snapshot.listeners[0];
  assert.equal(snapshot.listeners.length, 1); assert.equal(snapshot.operations.length, 0);
  assert.equal(metadata?.binding.address.port, f.server.boundAddress()?.port);
  assert.equal(metadata?.binding.address.hostname, "127.0.0.1");
  assert.equal(metadata?.binding.invocation, "discovery-only");
  assert.equal(metadata?.binding.authentication.kind, "native");
  assert.match(metadata!.binding.authentication.description, /POST \/api\/rabilink\/peer\/receive/);
  assert.match(metadata!.binding.authentication.description, /GET Upgrade \/api\/rabilink\/peer\/tunnel\/socket/);
  const document = (await apiCatalogOpenApi(snapshot));
  assert.deepEqual(Object.keys(document.paths as object), []);
  const listeners = document["x-rabiroute-external-listeners"] as Array<{ paths: unknown }>;
  assert.equal(listeners.length, 1); assert.deepEqual(Object.keys(listeners[0]!.paths as object), []);
  assert.equal((await f.native()).status, 400); assert.equal(f.calls(), 1);
  await owner.stop();
  assert.equal(f.registry.catalogSnapshot().listeners.length, 0);
  assert.ok(f.server.boundAddress());
  assert.equal(await (await f.native()).text(), "original-peer-owner"); assert.equal(f.calls(), 2);
  assert.deepEqual(f.errors, []);
});

test("physical stop removes discovery synchronously and a restart publishes a fresh lease at the actual port", async t => {
  const f = await fixture(t), active = identity("active"), owner = f.make(active); f.published.add(active.activationId); owner.start();
  await f.server.start(); const first = f.registry.catalogSnapshot().listeners[0]!.binding;
  owner.start(); assert.equal(f.registry.catalogSnapshot().listeners[0]!.binding.leaseId, first.leaseId);
  const stopping = f.server.stop(); assert.equal(f.registry.catalogSnapshot().listeners.length, 0); await stopping;
  await f.server.start(); const next = f.registry.catalogSnapshot().listeners[0]!.binding;
  assert.notEqual(next.leaseId, first.leaseId); assert.equal(next.address.port, f.server.boundAddress()?.port);
  assert.equal((await f.native()).status, 400); assert.deepEqual(f.errors, []);
});

test("a new published activation takes metadata over a surviving socket and stale callback context cannot revive its predecessor", async t => {
  const f = await fixture(t), oldIdentity = identity("old"), nextIdentity = identity("next");
  f.published.add(oldIdentity.activationId); const old = f.make(oldIdentity); old.start();
  await runPluginActivation(oldIdentity, () => f.server.start());
  const first = f.registry.catalogSnapshot().listeners[0]!.binding, address = f.server.boundAddress();
  const rejectedCandidate = f.make(identity("failed-candidate")); await rejectedCandidate.stop();
  assert.equal(f.registry.catalogSnapshot().listeners[0]!.binding.leaseId, first.leaseId);
  const next = f.make(nextIdentity); f.published.clear(); f.published.add(nextIdentity.activationId);
  runPluginActivation(oldIdentity, () => next.start());
  const second = f.registry.catalogSnapshot().listeners[0]!;
  assert.equal(second.owner.activationId, nextIdentity.activationId); assert.notEqual(second.binding.leaseId, first.leaseId);
  assert.deepEqual(f.server.boundAddress(), address);
  await old.stop(); assert.equal(f.registry.catalogSnapshot().listeners[0]!.binding.leaseId, second.binding.leaseId);
  await f.server.stop(); await runPluginActivation(oldIdentity, () => f.server.start());
  assert.equal(f.registry.catalogSnapshot().listeners[0]!.owner.activationId, nextIdentity.activationId);
  assert.equal((await f.native()).status, 400); assert.deepEqual(f.errors, []);
});

test("cancelled listener startup never publishes late metadata", async t => {
  const f = await fixture(t), active = identity("active"), owner = f.make(active); f.published.add(active.activationId); owner.start();
  const starting = f.server.start(); await f.server.stop(); await starting;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.registry.catalogSnapshot().listeners.length, 0); assert.equal(f.server.boundAddress(), undefined);
  await f.server.start(); assert.equal(f.registry.catalogSnapshot().listeners.length, 1);
});

test("metadata retirement joins its actual registration cleanup without closing the Peer socket", async t => {
  const f = await fixture(t), active = identity("active"), entered = gate(), release = gate(); t.after(release.resolve);
  const owner = f.make(active, { operations: { registerExternalListener(definition) {
    const registration = f.operations.registerExternalListener(definition);
    return { ...registration, async dispose() { entered.resolve(); await release.promise; await registration.dispose(); } };
  } } });
  f.published.add(active.activationId); await f.server.start(); owner.start();
  let finished = false; const stopping = owner.stop(); assert.equal(owner.stop(), stopping);
  void stopping.then(() => { finished = true; });
  try {
    await entered.promise;
    assert.equal(f.registry.catalogSnapshot().listeners.length, 0); assert.equal(finished, false);
    assert.equal((await f.native()).status, 400); release.resolve(); await stopping;
    assert.equal(finished, true); assert.ok(f.server.boundAddress());
  } finally { release.resolve(); await stopping; }
});

test("metadata registration failure is reported and leaves the original Peer ingress running", async t => {
  const f = await fixture(t), active = identity("active"); f.published.add(active.activationId);
  const owner = f.make(active, { operations: { registerExternalListener() { throw new Error("Controlled metadata registration failure."); } } });
  owner.start(); await f.server.start();
  assert.equal(f.registry.catalogSnapshot().listeners.length, 0); assert.equal(f.errors.length, 1);
  assert.equal((await f.native()).status, 400); await owner.stop(); assert.ok(f.server.boundAddress());
});

test("discovery never advertises a wildcard bind hostname as a connectable address", async () => {
  const registry = new ManagerPluginRouteRegistry(), active = identity("active");
  const owner = createPeerLanListenerMetadata({ identity: active,
    server: { boundAddress: () => ({ address: "0.0.0.0", family: "IPv4", port: 12345 }), subscribeStatus: () => () => {} },
    operations: { registerExternalListener: definition => registry.registerExternalListener(active.instanceId, definition) }, refresh: () => { registry.refreshPublication(); } });
  owner.start();
  assert.equal(registry.catalogSnapshot().listeners[0]!.binding.address.hostname, undefined);
  assert.equal(registry.catalogSnapshot().listeners[0]!.binding.address.port, 12345);
  await owner.stop(); assert.equal(registry.catalogSnapshot().listeners.length, 0);
});
