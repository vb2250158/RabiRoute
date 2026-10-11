import assert from "node:assert/strict";
import test from "node:test";
import { RabiPeerClient } from "./rabiPeerClient.js";
import { openPeerPacket, sealPeerPacket, type PeerRequest } from "./rabiPeerProtocol.js";

const token = "test-only-peer-application";
const identity = { deviceId: "fixture-target", generation: "fixture-generation", instanceId: "fixture-instance" };
const call = { targetDeviceId: identity.deviceId, capability: "transport", operation: "tunnel", input: { kind: "relay" } };
const base = "http://127.0.0.1:1"; // Fetch is mocked; never a network destination.

test("signalling discovers generation then performs exactly one allocation", async t => {
  const sent: PeerRequest[] = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = openPeerPacket<PeerRequest>(JSON.parse(String(init?.body)).packet, token); sent.push(request);
    return new Response(JSON.stringify(sealPeerPacket({ requestId: request.requestId, identity, ok: true, data: { ready: true } }, token)));
  });
  const client = new RabiPeerClient({ relay: () => ({ url: base, token }) });
  assert.deepEqual(await client.signal(call), { ready: true });
  assert.equal(sent.length, 2); assert.equal(sent[0].operation, "describe");
  assert.equal(sent[1].generation, identity.generation); assert.equal(sent[1].operation, "tunnel");
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  await assert.rejects(client.signal({ ...call, capability: "plans", operation: "list" }), /Invalid signalling/);
  assert.equal(sent.length, 2);
});

test("signalling allocation failure is not replayed on another transport", async t => {
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    starts++;
    if (starts === 2) throw new Error("unknown allocation result");
    const request = openPeerPacket<PeerRequest>(JSON.parse(String(init?.body)).packet, token);
    return new Response(JSON.stringify(sealPeerPacket({ requestId: request.requestId, identity, ok: true }, token)));
  });
  await assert.rejects(new RabiPeerClient({ relay: () => ({ url: base, token }) }).signal(call), /unknown allocation/);
  assert.equal(starts, 2);
});

test("credential changes and cancellation deny disclosure and subsequent allocation", async t => {
  for (const change of ["credential", "abort"] as const) await t.test(change, async t => {
    let current = token, starts = 0; const control = new AbortController();
    t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      starts++; const request = openPeerPacket<PeerRequest>(JSON.parse(String(init?.body)).packet, token);
      if (change === "credential") current = "changed"; else control.abort();
      return new Response(JSON.stringify(sealPeerPacket({ requestId: request.requestId, identity, ok: true }, token)));
    });
    const client = new RabiPeerClient({ relay: () => ({ url: base, token: current }) });
    await assert.rejects(client.signal(call, control.signal), /authority changed|cancelled/);
    assert.equal(starts, 1);
  });
});

test("signal reply rejects changed generation, missing instance and mismatched target", async t => {
  for (const invalid of [{ generation: "changed" }, { instanceId: "" }, { instanceId: "changed-instance" }, { deviceId: "wrong" }]) await t.test(JSON.stringify(invalid), async t => {
    let starts = 0;
    t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      starts++; const request = openPeerPacket<PeerRequest>(JSON.parse(String(init?.body)).packet, token);
      const replyIdentity = starts === 1 ? identity : { ...identity, ...invalid };
      return new Response(JSON.stringify(sealPeerPacket({ requestId: request.requestId, identity: replyIdentity, ok: true }, token)));
    });
    await assert.rejects(new RabiPeerClient({ relay: () => ({ url: base, token }) }).signal(call), /signalling rejected/);
    assert.equal(starts, 2);
  });
});
