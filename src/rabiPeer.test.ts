import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { RabiPeerDispatcher, openPeerPacket, sealPeerPacket, type PeerRequest, type PeerReply } from "./rabiPeerProtocol.js";

const token = "isolated-test-application";
const identity = { deviceId: "pc-b", generation: "generation-b", instanceId: "instance-b" };
function request(overrides: Partial<PeerRequest> = {}): PeerRequest {
  return { requestId: randomUUID(), targetDeviceId: identity.deviceId, generation: identity.generation,
    capability: "transport", operation: "tunnel", input: { kind: "relay" }, expiresAt: Date.now() + 60_000, ...overrides };
}
test("peer packets protect content and dispatcher rejects expired, stale, foreign and ungranted calls", async () => {
  let executed = 0;
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => ["transport.tunnel"], operations: [{ capability: "transport", operation: "tunnel", execute: () => { executed++; return ["private signal"]; } }] });
  const wire = sealPeerPacket(request(), token);
  assert.ok(!JSON.stringify(wire).includes("transport"));
  await assert.rejects(dispatcher.receive(sealPeerPacket(request(), "another-app")));
  await assert.rejects(dispatcher.receive(sealPeerPacket(request({ expiresAt: Date.now() - 1 }), token)));
  for (const change of [{ generation: "old" }, { targetDeviceId: "pc-c" }, { operation: "delete" }]) {
    const reply = openPeerPacket<PeerReply>(await dispatcher.receive(sealPeerPacket(request(change), token)), token);
    assert.equal(reply.ok, false);
  }
  assert.equal(executed, 0);
  const reply = openPeerPacket<PeerReply>(await dispatcher.receive(wire), token);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.data, ["private signal"]);
  assert.equal(executed, 1);
});


test("old wire cannot execute or advertise business APIs even when accidentally registered", async () => {
  let writes = 0;
  const dispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => ["plans.list", "transport.tunnel"], operations: [
      { capability: "plans", operation: "list", execute: () => { writes++; return "business"; } },
      { capability: "transport", operation: "tunnel", execute: () => ({ ready: true }) }
    ] });
  const rejected = openPeerPacket<PeerReply>(await dispatcher.receive(sealPeerPacket(request({ capability: "plans", operation: "list" }), token)), token);
  assert.equal(rejected.ok, false); assert.equal(rejected.error, "peer_operation_denied"); assert.equal(writes, 0);
  const described = openPeerPacket<PeerReply>(await dispatcher.receive(sealPeerPacket(request({ capability: "system", operation: "describe" }), token)), token);
  assert.deepEqual((described.data as { operations: unknown[] }).operations, [{ capability: "transport", operation: "tunnel", readOnly: false, controlPlane: true }]);
});


test("application disablement during allocation suppresses its result without reexecution", async () => {
  let enabled = true, allocations = 0;
  const dispatcher = new RabiPeerDispatcher({ token: () => token, identity: () => identity,
    allowed: () => enabled ? ["transport.tunnel"] : [], operations: [{ capability: "transport", operation: "tunnel", execute: async () => {
      allocations++; enabled = false; return "private-connection-result";
    } }] });
  const reply = openPeerPacket<PeerReply>(await dispatcher.receive(sealPeerPacket(request(), token)), token);
  assert.equal(reply.ok, false); assert.equal(reply.error, "peer_operation_denied"); assert.equal(reply.data, undefined); assert.equal(allocations, 1);
});
