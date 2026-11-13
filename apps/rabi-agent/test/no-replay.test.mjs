import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeliveryStore } from "../lib/delivery-store.mjs";
import { DeliveryOwner } from "../lib/delivery-owner.mjs";
import { EndpointAuthenticationError } from "../lib/endpoint-session.mjs";

const request = id => ({ intentId: id, agentType: "codex", sessionId: "source", request: {
  action: "send", deliveryId: id, sourceThreadId: "source", threadId: "completed-target", agentAdapter: "codex", prompt: "authorized new message" } });
const response = (state, id) => ({ ok: true, statusCode: 200, body: JSON.stringify({ data: { state, deliveryId: id } }) });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-no-replay-"));
  const filename = path.join(directory, "queue.sqlite");
  const owners = [];
  const create = transport => {
    const owner = new DeliveryOwner({ configPath: path.join(directory, "config.json"), config: { nodeId: "node", managerGuid: "manager" },
      store: new DeliveryStore(filename), client: () => ({ request: transport }), sendEvent: () => {} });
    owner.wake = () => {};
    owners.push(owner);
    return owner;
  };
  t.after(async () => { for (const owner of owners) if (!owner.stopped) await owner.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { create };
}

test("unknown result remains a state marker across reconnect, duplicate submit and restart", async t => {
  const f = fixture(t); let sends = 0;
  const transport = async () => { sends++; throw new Error("receipt lost"); };
  const first = f.create(transport);
  first.submit(request("original")); await first.tick();
  assert.equal(first.query({ action: "get", intentId: "original" }).item.state, "awaiting_confirmation");
  first.submit(request("original")); await first.tick(); first.resume(); await first.tick();
  await first.close();
  const restarted = f.create(transport);
  for (let count = 0; count < 5; count++) await restarted.tick();
  assert.equal(sends, 1);
  assert.equal(restarted.store.list().items.length, 1);
  assert.equal(restarted.query({ action: "get", intentId: "original" }).item.state, "awaiting_confirmation");
  restarted.submit(request("fresh")); await restarted.tick();
  assert.equal(sends, 2, "an old unknown record must not block a new authorized send to the same target");
});

test("preflight failure keeps the unsent first attempt available after recovery", async t => {
  const f = fixture(t); let ready = false, posts = 0;
  const owner = f.create(async () => { posts++; return { ok: true, statusCode: 200, body: JSON.stringify({ data: { status: "delivered", delivery: { status: "accepted", deliveryId: "first" } } }) }; });
  owner.backoff = () => 0;
  owner.client = () => { if (!ready) throw new Error("Manager unavailable before request"); return { request: async () => { posts++; return { ok: true, statusCode: 200, body: JSON.stringify({ data: { status: "delivered", delivery: { status: "accepted", deliveryId: "first" } } }) }; } }; };
  owner.submit(request("first")); await owner.tick();
  assert.equal(posts, 0); assert.equal(owner.store.get("first").state, "pending"); assert.equal(owner.store.get("first").attempts, 0);
  ready = true; await owner.tick(); await owner.tick();
  assert.equal(posts, 1); assert.equal(owner.store.get("first").state, "delivered");
});

for (const failure of ["missing-guid", "other-guid", "authentication"]) test(`unsent ${failure} rechecks the original authority before its first POST`, async t => {
  const f = fixture(t); let identity = { nodeId: "node", managerGuid: "manager" }, ready = false, posts = 0;
  const owner = f.create(async () => { throw new Error("unexpected fixture call"); }); owner.backoff = () => 0; owner.readIdentity = () => identity;
  owner.client = (_type, _session, guid) => { assert.equal(guid, "manager"); if (failure === "authentication" && !ready) throw new EndpointAuthenticationError("not ready");
    return { request: async () => { posts++; return { ok: true, statusCode: 200, body: JSON.stringify({ data: { status: "delivered", delivery: { status: "accepted", deliveryId: "first" } } }) }; } }; };
  owner.submit(request("first"));
  if (failure === "missing-guid") identity = { nodeId: "node" };
  if (failure === "other-guid") identity = { nodeId: "node", managerGuid: "other" };
  await owner.tick(); assert.equal(posts, 0); assert.equal(owner.store.get("first").state, "blocked"); assert.equal(owner.store.get("first").attempts, 0);
  identity = { nodeId: "node", managerGuid: "manager" }; ready = true; await owner.tick(); await owner.tick();
  assert.equal(posts, 1); assert.equal(owner.store.get("first").state, "delivered");
});

test("queued historical records never start on owner restart or receipt-only reconcile", async t => {
  const f = fixture(t); let sends = 0;
  const first = f.create(async () => { sends++; return response("prepared", "old"); });
  first.submit(request("queued-before-restart")); await first.close();
  const restarted = f.create(async method => { assert.equal(method, "GET"); return response("prepared", "old"); });
  restarted.start(); await restarted.tick();
  await restarted.control({ action: "reconcile", intentId: "queued-before-restart" });
  assert.equal(sends, 0);
  assert.equal(restarted.store.get("queued-before-restart").state, "unknown");
});

test("pre-send blocked records are not first-sent after owner restart", async t => {
  const f = fixture(t); let sends = 0;
  const first = f.create(async () => { sends++; throw new Error("unexpected send"); });
  first.client = () => { throw new EndpointAuthenticationError("not ready"); };
  first.submit(request("blocked-before-restart")); await first.tick();
  assert.equal(first.store.get("blocked-before-restart").state, "blocked"); assert.equal(first.store.get("blocked-before-restart").attempts, 0);
  await first.close();
  const restarted = f.create(async () => { sends++; throw new Error("unexpected send"); });
  await restarted.tick(); assert.equal(sends, 0); assert.equal(restarted.store.get("blocked-before-restart").state, "unknown");
});

test("cancel returns its durable tombstone without waiting for unreachable Manager", async t => {
  const f = fixture(t);
  const owner = f.create(async () => { throw new Error("offline"); });
  owner.submit(request("cancel-me")); await owner.tick();
  let attempted = false;
  owner.client = () => ({ request: () => { attempted = true; return new Promise(() => {}); } });
  const result = await owner.control({ action: "cancel", intentId: "cancel-me" });
  assert.equal(result.record.state, "cancelled");
  assert.equal(result.record.managerCancelPending, true);
  assert.equal(attempted, false);
});
