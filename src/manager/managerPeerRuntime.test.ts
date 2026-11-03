import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PeerTunnelRuntime } from "../peerTunnel/runtime.js";
import { createManagerApiOperationsService, ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createManagerPeerRuntime, type ManagerPeerPublication, type ManagerPeerRuntimeOptions } from "./managerPeerRuntime.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: test.TestContext) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "manager-peer-composition-"));
  const owners: Awaited<ReturnType<typeof createManagerPeerRuntime>>[] = [];
  let published: ManagerPeerPublication = {};
  t.after(async () => {
    await Promise.all(owners.map(owner => owner.stop()));
    rmSync(folder, { recursive: true, force: true });
  });
  const options = (id: string): ManagerPeerRuntimeOptions => ({
    peer: { identity: () => ({ deviceId: "fixture-pc", generation: "fixture-generation", instanceId: "fixture-manager" }),
      token: () => "fixture-application", enabled: () => true, peers: async () => [],
      relay: () => ({ url: "http://127.0.0.1", token: "fixture-application" }),
      readJson: async () => ({}), json: (response, status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); } },
    tunnel: { readOnly: true, dataDir: path.join(folder, id), deviceId: "fixture-pc", generation: "fixture-generation",
      discover: async () => [], relay: () => ({ url: "http://127.0.0.1", token: "fixture-application" }),
      services: () => ({}), onStatus: () => {}, allowApplicationConnection: () => true, allowControl: () => true },
    metadata: {
      identity: { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", activationId: id,
        instanceId: "manager:rabilink-relay", pluginId: "io.rabiroute.manager.rabilink-relay", version: "1.0.0", revision: id, host: "manager" },
      server: { boundAddress: () => undefined, subscribeStatus: () => () => {}, status: () => ({ state: "disabled", urls: [] }) },
      operations: { registerExternalListener: () => { throw new Error("No listener should be published in this fixture."); } }, refresh: () => {}
    },
    bootstrap: { current: () => ({ scope: "fixture-scope", generation: "fixture-generation", deviceId: "fixture-pc" }),
      allowed: () => true, identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }) },
    publication: { current: () => published, set: value => { published = value; } }, admitUpgrade: () => true
  });
  return { options, current: () => published,
    async prepare(id: string, configure?: (value: ManagerPeerRuntimeOptions) => void) {
      const value = options(id); configure?.(value);
      const owner = await createManagerPeerRuntime(value); owners.push(owner); return owner;
    } };
}

test("preparation failure preserves the active Peer and closes its own transport", async t => {
  const f = fixture(t), active = await f.prepare("active"); active.publish();
  const original = f.current(), options = f.options("rejected");
  const failure = new Error("fixture metadata preparation failed");
  Object.defineProperty(options.metadata, "identity", { get() { throw failure; } });
  const stop = PeerTunnelRuntime.prototype.stop;
  let closedCandidates = 0;
  PeerTunnelRuntime.prototype.stop = function () { closedCandidates++; return stop.call(this); };
  try { await assert.rejects(createManagerPeerRuntime(options), error => error === failure); }
  finally { PeerTunnelRuntime.prototype.stop = stop; }
  assert.equal(closedCandidates, 1);
  assert.deepEqual(f.current(), original);
  active.start();
});

test("candidate rollback restores original pointers and old retirement preserves replacement", async t => {
  const f = fixture(t), original = await f.prepare("original"), candidate = await f.prepare("candidate");
  assert.deepEqual(f.current(), {});
  assert.throws(() => candidate.start(), /no longer published/);
  original.publish(); original.start();
  const first = f.current();
  candidate.publish(); candidate.start();
  const second = f.current();
  assert.notEqual(second.tunnel, first.tunnel);
  candidate.rollback(); assert.deepEqual(f.current(), first);
  candidate.publish();
  await original.stop(); assert.deepEqual(f.current(), second);
  await candidate.stop(); assert.deepEqual(f.current(), { tunnel: undefined, runtime: undefined });
});

test("stop unpublishes immediately and joins all owned cleanup before completing", async t => {
  const f = fixture(t), owner = await f.prepare("pending"); owner.publish();
  const current = f.current(), pending = gate();
  const stopTunnel = current.tunnel!.stop.bind(current.tunnel), stopRuntime = current.runtime!.stop.bind(current.runtime);
  let runtimeStopped = false, complete = false;
  current.tunnel!.stop = async () => { await pending.promise; await stopTunnel(); };
  current.runtime!.stop = async () => { await stopRuntime(); runtimeStopped = true; };
  const stopping = owner.stop().then(() => { complete = true; });
  assert.equal(owner.stop(), owner.stop());
  assert.deepEqual(f.current(), { tunnel: undefined, runtime: undefined });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(complete, false); assert.equal(runtimeStopped, true);
  pending.resolve(); await stopping; assert.equal(complete, true);
});

test("composed candidate retains control, bootstrap, opaque HTTP and WebSocket contracts", async t => {
  const f = fixture(t), owner = await f.prepare("contracts");
  const ids = owner.operations.map(operation => operation.contract.operationId);
  for (const id of ["manager.rabilink.peer.servers.read", "manager.rabilink.peer.receive", "manager.rabilink.peer.list",
    "manager.rabilink.peer.device-bootstrap", "manager.rabilink.peer.persona.bootstrap"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(owner.httpOperations.length, 8);
  assert.equal(owner.upgradeOperation.contract.pathTemplate, "/api/rabilink/peer/http/:deviceId/:service/:path");
});


test("published composition owns shared LAN metadata and joins its retirement without clearing the replacement", async t => {
  const f = fixture(t), published = new Set<string>(), entered = gate(), release = gate();
  const registry = new ManagerPluginRouteRegistry(() => published, { identity: () => ({
    applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins"
  }) });
  const operations = createManagerApiOperationsService(registry);
  let subscriptions = 0, discoveryStarts = 0;
  const server: ManagerPeerRuntimeOptions["metadata"]["server"] = {
    boundAddress: () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 }),
    status: () => ({ state: "listening", port: 12345, urls: ["http://127.0.0.1:12345"] }),
    subscribeStatus: () => { subscriptions++; return () => { subscriptions--; }; }
  };
  const prepare = (id: string) => f.prepare(id, options => {
    options.metadata = { ...options.metadata, server, refresh: () => registry.refreshPublication(),
      operations: { registerExternalListener(definition) {
        const registration = operations.registerExternalListener(definition);
        return { ...registration, async dispose() {
          if (id === "old-listener") { entered.resolve(); await release.promise; }
          await registration.dispose();
        } };
      } }
    };
  });
  const original = await prepare("old-listener"), replacement = await prepare("new-listener");
  try {
    published.add("old-listener"); original.publish();
    f.current().tunnel!.startLanDiscovery = port => { assert.equal(port, 12345); discoveryStarts++; };
    original.start();
    const first = registry.catalogSnapshot().listeners[0]!;
    assert.equal(first.owner.activationId, "old-listener"); assert.equal(first.binding.address.port, 12345);
    assert.equal(subscriptions, 1);
    published.clear(); published.add("new-listener"); replacement.publish();
    f.current().tunnel!.startLanDiscovery = port => { assert.equal(port, 12345); discoveryStarts++; };
    replacement.start();
    const next = registry.catalogSnapshot().listeners[0]!, current = f.current();
    assert.equal(next.owner.activationId, "new-listener"); assert.notEqual(next.binding.leaseId, first.binding.leaseId);
    assert.equal(subscriptions, 2); assert.equal(discoveryStarts, 2);
    original.stopAccepting();
    assert.equal(subscriptions, 1);
    assert.equal(registry.catalogSnapshot().listeners[0]!.binding.leaseId, next.binding.leaseId);
    let stopped = false; const stopping = original.stop().then(() => { stopped = true; });
    await entered.promise;
    assert.equal(stopped, false); assert.deepEqual(f.current(), current);
    release.resolve(); await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(f.current(), current);
    assert.equal(registry.catalogSnapshot().listeners[0]!.binding.leaseId, next.binding.leaseId);
    replacement.stopAccepting();
    assert.equal(subscriptions, 0); assert.equal(registry.catalogSnapshot().listeners.length, 0);
    await replacement.stop();
  } finally { release.resolve(); await Promise.all([original.stop(), replacement.stop()]); }
});
