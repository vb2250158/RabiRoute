import assert from "node:assert/strict";
import test from "node:test";
import { PeerConnections } from "./connections.js";
import { openPeerEvents, PEER_EVENT_LIMITS } from "./events.js";

function connections() { return new PeerConnections(async () => { throw new Error("Event subscriptions must never discover/connect peers."); }); }

test("Peer events retain connected/status/selection framing and stop the original listeners at EOF", async () => {
  const owner = connections(), stopped = new AbortController();
  const source = openPeerEvents(owner, stopped.signal, ["visible"], () => {}), iterator = source.frames[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { comment: "connected" });
  owner.emit("status", { deviceId: "hidden" }); owner.emit("status", { deviceId: "visible", future: "retained" });
  assert.deepEqual((await iterator.next()).value, { event: "status", data: { deviceId: "visible", future: "retained" } });
  owner.emit("selection", { selectedDeviceId: "other" });
  assert.deepEqual((await iterator.next()).value, { event: "selection", data: { selectedDeviceId: "other" } });
  const waiting = iterator.next(); stopped.abort(); assert.equal((await waiting).done, true);
  assert.equal(owner.listenerCount("status"), 0); assert.equal(owner.listenerCount("selection"), 0); owner.stop();
});

test("Peer queue overflow and original admission revocation close the consumer without running publisher code", async () => {
  for (const revoke of [false, true]) {
    const owner = connections(), stopped = new AbortController(); let allowed = true;
    const source = openPeerEvents(owner, stopped.signal, [], () => { if (!allowed) throw new Error("revoked"); });
    if (revoke) allowed = false;
    owner.emit("selection", { selectedDeviceId: "x".repeat(revoke ? 1 : PEER_EVENT_LIMITS.queuedBytes) });
    assert.equal(source.signal!.aborted, true); assert.equal(owner.listenerCount("selection"), 0);
    assert.equal((await source.frames[Symbol.asyncIterator]().next()).done, true); await source.cancel("closed"); owner.stop();
  }
});

test("Peer cancellation joins accepted live-channel RTT work and prevents overlapping heartbeat probes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const owner = connections(), stopped = new AbortController();
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; }); let probes = 0;
  owner.refreshLatency = async ids => { assert.deepEqual(ids, ["visible"]); probes++; await pending; };
  const source = openPeerEvents(owner, stopped.signal, ["visible"], () => {});
  try {
    t.mock.timers.tick(PEER_EVENT_LIMITS.heartbeatMs * 3); assert.equal(probes, 1);
    let closed = false; const cancellation = Promise.resolve(source.cancel("retired")).then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false); assert.equal(owner.listenerCount("status"), 0);
    finish(); await cancellation; assert.equal(closed, true);
    assert.equal((await source.frames[Symbol.asyncIterator]().next()).done, true);
  } finally { finish(); await source.cancel("cleanup"); owner.stop(); }
});
