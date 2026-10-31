import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { createPeerRuntimeOwner } from "./pluginRuntime.js";
import { TunnelSession, establishTunnel } from "./session.js";
import { loadTunnelIdentity } from "./security.js";
import type { TunnelChannel } from "./channel.js";
import { serveTunnel, proxyTunnel } from "./http.js";
import { PeerConnections } from "./connections.js";
import { TunnelRtc } from "./rtc.js";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

test("one Manager keeps old Peer on failed candidate and publishes replacement before old drain", async t => {
  const pluginPath = new URL("../../plugins/builtin/io.rabiroute.manager.rabilink-relay/1.0.0/manager.mjs", import.meta.url);
  const plugin = await import(pluginPath.href) as PluginModule;
  const oldDrain = gate();
  let active: number | undefined, created = 0, failing = false, failPublication = false, sharedStops = 0, publications = 0, initialSync: unknown;
  const peers: { id: number; stopped: boolean; closed: boolean; publish(): void; stopAccepting(): void; stop(): Promise<void>; operations: []; httpOperations: []; upgradeOperation: {} }[] = [];
  const host = {
    managerListenerReady: true,
    syncActiveRabiLinkRelay: async () => {},
    syncRabiLinkRelayRuntime: async () => {},
    peerLanServer: { stop: async () => { sharedStops++; } },
    rabiLinkRelayRuntime: { stop: async () => { sharedStops++; } },
    createDirectVideoReceiver: () => ({ stop: async () => {} }),
    createDirectVideoOperations: () => [], createRabiLinkAgentDeviceOperations: () => [],
    createRabiLinkMobileOperations: () => [], createDeviceAgentOperations: () => [],
    createPeerRuntime() {
      const id = ++created;
      let previous: number | undefined;
      const peer = { id, stopped: false, closed: false, operations: [] as [], httpOperations: [] as [], upgradeOperation: {},
        start() {},
        ...createPeerRuntimeOwner({
          publish: () => { previous = active; active = id; publications++; if (failPublication) throw new Error("controlled pointer publication failure"); },
          rollback: () => { if (active === id) active = previous; },
          unpublish: () => { if (active === id) active = undefined; },
          stopAccepting: () => { peer.stopped = true; },
          stop: async () => { peer.closed = true; }
        })
      };
      peers.push(peer); return peer;
    },
    managerPluginRoutes: {
      registerOperationsAsync: async () => {
        if (failing) throw new Error("controlled candidate registration failure");
        const id = created;
        return { stopAccepting() {}, dispose: async () => { if (id === 1) await oldDrain.promise; } };
      },
      registerUpgrades: () => ({ stopAccepting() {}, dispose: async () => {} }),
      registerHttpProxies: () => ({ dispose: async () => {} })
    }
  };
  const kernel = new GenerationRuntime({ host: "manager", readyRequires: ["manager.rabilink-relay@1"],
    hostServices: [{ capability: "host.manager.rabilink-relay@1", value: host }],
    executor: { prepare: async () => plugin }
  });
  t.after(() => { oldDrain.release(); return kernel.dispose(); });
  const candidate = (revision: string): PluginCandidate => ({ instanceId: "fixture:peer", revision, config: {},
    manifest: { schemaVersion: 2, id: "io.fixture.peer", version: "1.0.0", entries: { manager: { execution: "in_process", module: "manager.mjs" } },
      provides: ["manager.rabilink-relay@1"], requires: ["host.manager.rabilink-relay@1"], optional: [], permissions: [] },
    entry: { execution: "in_process", path: pluginPath.pathname }
  });
  await kernel.switch([candidate("one")]);
  assert.equal(active, 1); initialSync = host.syncActiveRabiLinkRelay;
  failing = true;
  await kernel.switch([candidate("bad")]).catch(() => {});
  assert.equal(active, 1); assert.equal(publications, 1); assert.equal(sharedStops, 0);
  assert.equal(host.syncActiveRabiLinkRelay, initialSync); assert.equal(peers[1].closed, true);
  assert.equal(peers[0].stopped, false);
  failing = false;
  failPublication = true;
  await assert.rejects(kernel.switch([candidate("publish-failed")]), /controlled pointer publication failure/);
  assert.equal(active, 1); assert.equal(host.syncActiveRabiLinkRelay, initialSync);
  assert.equal(peers[0].stopped, false); assert.equal(peers[2].closed, true); assert.equal(sharedStops, 0);
  failPublication = false;
  const replacement = kernel.switch([candidate("two")]);
  // Publication is observable while the old accepted operation is still draining.
  const publishedPeer = () => active;
  for (let turn = 0; publishedPeer() !== 4 && turn < 30; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(active, 4); assert.equal(peers[0].closed, false); assert.equal(sharedStops, 0);
  oldDrain.release(); await replacement;
  assert.equal(peers[0].closed, true); assert.equal(active, 4); assert.equal(sharedStops, 0);
  await kernel.switch([candidate("one")]); // Fresh candidate for an explicit rollback.
  assert.equal(active, 5); assert.equal(publications, 4); assert.equal(sharedStops, 0);
  await kernel.dispose(); assert.equal(active, undefined); assert.equal(sharedStops, 2);
});

test("session retirement joins accepted writes and native producer cleanup", async () => {
  const sendGate = gate(), producerGate = gate();
  const channel = new EventEmitter() as TunnelChannel;
  channel.send = async () => { await sendGate.promise; };
  channel.close = () => { channel.emit("close"); };
  const session = new TunnelSession({} as never, {} as never, channel, { encode: () => Buffer.from("fixture"), decode: () => ({}) }, true);
  const stream = session.open({ service: "fixture", method: "GET", path: "/slow", headers: {} });
  await new Promise<void>(resolve => setImmediate(resolve));
  session.trackProducer(producerGate.promise);
  let done = false;
  const closing = session.close().then(() => { done = true; });
  assert.equal(session.closed, true); assert.equal(stream.destroyed, true);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(done, false);
  sendGate.release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(done, false);
  producerGate.release(); await closing; assert.equal(stream.closed, true);
  await session.close();
});

test("connection retirement cancels and joins a real pending connection producer", async () => {
  const cleanup = gate(), entered = gate(); let cancelled = false;
  const connections = new PeerConnections(async (_peer, _transport, signal) => {
    entered.release();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    await cleanup.promise;
    throw new Error("cancelled fixture producer");
  });
  const pending = connections.get({ id: "fixture", name: "fixture", online: true, trusted: true, supported: true, peerUrls: [] }).catch(() => {});
  await entered.promise; let stopped = false;
  const stopping = connections.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelled, true); assert.equal(stopped, false);
  cleanup.release(); await Promise.all([pending, stopping]);
  await assert.rejects(connections.get({ id: "fixture", name: "fixture", online: true, trusted: true, supported: true, peerUrls: [] }), /stopped/);
});

test("a connection returned after cancellation is closed and joined before retirement completes", async () => {
  const entered = gate(), nativeClose = gate();
  const channel = new EventEmitter() as TunnelChannel;
  channel.send = async () => {};
  channel.close = async () => { await nativeClose.promise; channel.emit("close"); };
  const late = new TunnelSession({} as never, {} as never, channel, { encode: () => Buffer.alloc(0), decode: () => ({}) }, true);
  const connections = new PeerConnections(async (_peer, _transport, signal) => {
    entered.release();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return late;
  });
  const acquiring = connections.get({ id: "late", name: "late", online: true, trusted: true, supported: true, peerUrls: [] }).catch(() => {});
  await entered.promise;
  let done = false;
  const stopping = connections.stop().then(() => { done = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(late.closed, true); assert.equal(done, false);
  nativeClose.release(); await Promise.all([stopping, acquiring]); assert.equal(done, true);
});

test("RTC retirement joins the accepted signalling producer after cancellation", { timeout: 15000 }, async () => {
  const rtc = new TunnelRtc([]), signalling = gate(), cleanup = gate(), controller = new AbortController();
  const connecting = rtc.connect(async () => {
    signalling.release(); await cleanup.promise;
    throw new Error("cancelled signalling producer");
  }, controller.signal).catch(() => {});
  await signalling.promise; controller.abort();
  let stopped = false;
  const stopping = rtc.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  cleanup.release(); await Promise.all([connecting, stopping]); assert.equal(stopped, true);
});

test("signed in-memory Peer handles native HEAD and retires real served HTTP producer", async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "peer-retirement-"));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  const a = loadTunnelIdentity(path.join(folder, "a.json"), "a", "fixture"), b = loadTunnelIdentity(path.join(folder, "b.json"), "b", "fixture");
  const ac = new EventEmitter() as TunnelChannel, bc = new EventEmitter() as TunnelChannel;
  let disconnected = false;
  ac.send = async bytes => { setImmediate(() => { if (!disconnected) bc.emit("data", bytes); }); };
  bc.send = async bytes => { setImmediate(() => { if (!disconnected) ac.emit("data", bytes); }); };
  ac.close = bc.close = () => { if (!disconnected) { disconnected = true; ac.emit("close"); bc.emit("close"); } };
  const [caller, receiver] = await Promise.all([
    establishTunnel(ac, a, { deviceId: b.deviceId, publicKey: b.publicKey, services: ["fixture"] }, true, AbortSignal.timeout(2000)),
    establishTunnel(bc, b, { deviceId: a.deviceId, publicKey: a.publicKey, services: ["fixture"] }, false, AbortSignal.timeout(2000))
  ]);
  t.after(async () => { await Promise.all([caller.close(), receiver.close()]); });
  const started = gate(), remoteClosed = gate();
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD") { request.resume(); response.writeHead(200, { "x-fixture": "head" }); response.end("no HEAD bytes"); return; }
    response.once("close", remoteClosed.release); started.release(); response.writeHead(200); response.write("pending");
    request.resume();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  serveTunnel(receiver, () => ({ fixture: { baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` } }));
  const front = http.createServer((request, response) => { void proxyTunnel(caller, "fixture", "/head", request, response); });
  front.listen(0, "127.0.0.1"); await once(front, "listening");
  t.after(() => { front.closeAllConnections(); front.close(); });
  await new Promise<void>((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${(front.address() as import("node:net").AddressInfo).port}`, { method: "HEAD" }, response => {
      assert.equal(response.statusCode, 200); assert.equal(response.headers["x-fixture"], "head");
      response.on("data", () => reject(new Error("HEAD emitted response bytes"))); response.once("end", resolve); response.resume();
    }); request.once("error", reject); request.end();
  });
  const stream = caller.open({ service: "fixture", method: "GET", path: "/slow", headers: {} }); stream.end();
  await started.promise;
  await receiver.close();
  await remoteClosed.promise;
  assert.equal(stream.destroyed, true);
});

test("Peer publication cleanup preserves falsy failures and joins the original stop", async () => {
  const cleanup = gate(); const calls: string[] = [];
  let reentrant: Promise<void> | undefined;
  const owner = createPeerRuntimeOwner({ publish() {}, rollback() {},
    stopAccepting() { calls.push("fence"); reentrant = owner.stop(); throw undefined; },
    unpublish() { calls.push("unpublish"); },
    async stop() { calls.push("stop"); await cleanup.promise; }
  });
  owner.publish(); const stopping = owner.stop();
  assert.equal(stopping, reentrant); assert.equal(stopping, owner.stop());
  let settled = false; void stopping.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["fence", "unpublish", "stop"]); assert.equal(settled, false);
  cleanup.release(); await assert.rejects(stopping, error => error === undefined);
});
test("one native channel close failure is retained while other sessions and producers join", async () => {
  const producer = gate(), healthyClose = gate(); let healthyClosed = false;
  const make = (close: () => Promise<void>) => {
    const channel = new EventEmitter() as TunnelChannel; channel.send = async () => {}; channel.close = close;
    return new TunnelSession({} as never, {} as never, channel, {encode:()=>Buffer.alloc(0),decode:()=>({})},true);
  };
  const bad = make(async () => { throw undefined; }); bad.trackProducer(producer.promise);
  const healthy = make(async () => { await healthyClose.promise; healthyClosed = true; });
  const pool = new PeerConnections(async () => { throw new Error("no new connections"); });
  const own = Reflect.get(pool,"own"); own.call(pool,bad,"bad"); own.call(pool,healthy,"healthy");
  const stopped = pool.stop(); assert.equal(stopped,pool.stop());
  let settled = false; void stopped.then(()=>{settled=true;},()=>{settled=true;});
  await new Promise<void>(resolve=>setImmediate(resolve)); assert.equal(settled,false);
  producer.release(); await new Promise<void>(resolve=>setImmediate(resolve)); assert.equal(settled,false);
  healthyClose.release(); await assert.rejects(stopped,error=>error===undefined); assert.equal(healthyClosed,true);
  assert.equal(bad.close(),bad.close()); await assert.rejects(bad.close(),error=>error===undefined);
});

test("RTC stop retains a native close failure observed before final retirement", async () => {
  const rtc = new TunnelRtc([]), current = Reflect.get(rtc,"create").call(rtc);
  const original = current.peer.close.bind(current.peer);
  current.peer.close = async () => { await original(); throw false; };
  await assert.rejects(current.close(),error=>error===false);
  const stopped = rtc.stop(); assert.equal(stopped,rtc.stop()); await assert.rejects(stopped,error=>error===false);
});