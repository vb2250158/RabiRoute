import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonFileAgentRequestPersistence } from "./persistence.js";
import { AgentRequestStore } from "./store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions } from "./endpointDelivery.js";
import type { AgentRequestEndpoint } from "./endpoint.js";

const preparation = () => ({ source: { threadId: "source", agentType: "agent" }, target: { threadId: "target", agentType: "agent" },
  responsePolicy: "required" as const, responseInstruction: "Reply with the result." });

async function originalEvidence() {
  let raw: any;
  const store = new AgentRequestStore({ read: () => raw, write: value => { raw = structuredClone(value); } });
  const endpoint = (sessionId: string): AgentRequestEndpoint => ({ kind: "local", managerInstanceId: "fixture-manager", agentId: "local:dsh",
    provider: "dsh", sessionId, authorizationIncarnation: "fixture-incarnation" });
  const party = (threadId: string) => ({ endpoint: endpoint(threadId), agentAdapter: "dsh" as const, agentType: "agent", threadId });
  const options: EndpointDeliveryOptions = { store, managerInstanceId: "fixture-manager", resolveSource: () => party("source"),
    resolveTarget: () => party("target"), resolveExecutionOptions: () => ({}), authorize: () => {},
    dispatch: async value => ({ deliveryId: value.deliveryId, generation: value.generation, promptHash: value.promptHash,
      executionOptionsHash: value.executionOptionsHash, endpoint: value.target, accepted: true, action: "started", transport: "fixture" }), reconcile: async () => undefined };
  await executeEndpointAgentDelivery({ action: "send", deliveryId: "fixture-intent", sourceThreadId: "source", sourceAgentType: "agent",
    threadId: "target", agentAdapter: "dsh", prompt: "Private fixture body", responsePolicy: "none",
    messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "source", sessionName: "Source" } }, options);
  return raw;
}

test("only a genuinely absent file is an authoritative empty delivery owner", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-evidence-"));
  const owners: AgentRequestStore[] = [];
  t.after(async () => { for (const owner of owners) await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "requests.json");
  const persistence = new JsonFileAgentRequestPersistence(file);
  assert.equal(persistence.read(), undefined);
  const store = new AgentRequestStore(persistence);
  owners.push(store);
  await store.ready();
  assert.deepEqual(store.getEndpointDeliveryEvidenceStatus(), { available: true });
  await store.prepare(preparation());
  await store.close();
  const restarted = new AgentRequestStore(persistence);
  owners.push(restarted);
  await restarted.ready();
  assert.equal(restarted.getEndpointDeliveryEvidenceStatus().available, true);
});

test("unreadable or corrupt files do not crash the owner or permit overwriting original bytes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-evidence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "requests.json");
  for (const content of ["{truncated", "null", "[]", '"invalid-root"', '{"version":2,"requests":{}}']) {
    fs.writeFileSync(file, content);
    const store = new AgentRequestStore(file);
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false, content);
    await assert.rejects(async () => await store.prepare(preparation()));
    assert.equal(fs.readFileSync(file, "utf8"), content);
    await store.close();
  }
  assert.throws(() => new JsonFileAgentRequestPersistence(dir).read(), /could not be read/);
  const unreadable = new AgentRequestStore(dir);
  assert.equal(unreadable.getEndpointDeliveryEvidenceStatus().available, false);
  await assert.rejects(async () => await unreadable.prepare(preparation()));
  assert.equal(fs.statSync(dir).isDirectory(), true);
  await unreadable.close();
});

test("unsupported versions and malformed collections cannot prove delivery absence", async () => {
  for (const raw of [null, [], false, { requests: {} }, { version: 2, requests: {} }, { version: 1, requests: [] },
    { version: 1, requests: {}, deliveries: [] }, { version: 1, requests: {}, unavailableDeliveryIds: {} },
    { version: 1, requests: {}, unavailableDeliveryIds: [null] }]) {
    let writes = 0;
    const store = new AgentRequestStore({ read: () => raw, write: () => { writes++; } });
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false, JSON.stringify(raw));
    await assert.rejects(async () => await store.prepare(preparation()));
    assert.equal(writes, 0);
  }
});

test("missing requests do not discard readable deliveries or reserved tombstones", async () => {
  const raw = await originalEvidence(); const deliveryId = Object.keys(raw.deliveries)[0];
  delete raw.requests; raw.unavailableDeliveryIds = ["fixture-corrupt-reservation"];
  const before = JSON.stringify(raw); let writes = 0;
  const store = new AgentRequestStore({ read: () => raw, write: () => { writes++; } });
  assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false);
  assert.equal(store.getEndpointDelivery(deliveryId)?.state, "committed");
  assert.equal(store.hasEndpointDeliveryReservation(deliveryId), true);
  assert.equal(store.hasEndpointDeliveryReservation("fixture-corrupt-reservation"), true);
  await assert.rejects(async () => await store.prepare(preparation()));
  assert.equal(writes, 0); assert.equal(JSON.stringify(raw), before);
});

test("malformed prompt evidence is isolated while its ID and healthy neighboring records survive", async () => {
  const original = await originalEvidence(); const deliveryId = Object.keys(original.deliveries)[0];
  for (const prompt of [undefined, null, 7, {}, ["body"], "different body"]) {
    const raw = structuredClone(original);
    raw.deliveries["fixture-broken"] = { ...structuredClone(raw.deliveries[deliveryId]), deliveryId: "fixture-broken",
      preparation: { ...raw.deliveries[deliveryId].preparation, deliveryId: "fixture-broken" }, prompt };
    let persisted = raw; let writes = 0;
    const persistence = { read: () => persisted, write: (value: unknown) => { persisted = structuredClone(value); writes++; } };
    const store = new AgentRequestStore(persistence);
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, true);
    assert.equal(store.hasEndpointDeliveryReservation("fixture-broken"), true);
    assert.equal(store.getEndpointDelivery("fixture-broken"), undefined);
    assert.equal(store.getEndpointDelivery(deliveryId)?.state, "committed");
    const before = structuredClone(raw.deliveries["fixture-broken"]);
    await store.prepare(preparation()); assert.equal(writes, 1);
    assert.deepEqual(persisted.deliveries["fixture-broken"], before);
    const restarted = new AgentRequestStore(persistence);
    assert.equal(restarted.getEndpointDeliveryEvidenceStatus().available, true);
    assert.equal(restarted.hasEndpointDeliveryReservation("fixture-broken"), true);
    assert.equal(restarted.getEndpointDelivery(deliveryId)?.state, "committed");
  }
});

test("damaged requests with complete reservation IDs retain original fields on unrelated writes", async () => {
  const broken = { id: "broken-request", deliveryId: "original-send", pendingResponseDeliveryId: "original-reply",
    response: { deliveryId: "original-response", privateFixtureField: "original body" }, status: "broken",
    arbitrary: { preserve: ["all", "original", "fields"] } };
  let persisted: any = { version: 1, requests: { "broken-request": structuredClone(broken) } };
  const persistence = { read: () => persisted, write: (value: unknown) => { persisted = structuredClone(value); } };
  const store = new AgentRequestStore(persistence);
  assert.equal(store.getEndpointDeliveryEvidenceStatus().available, true);
  for (const id of ["original-send", "original-reply", "original-response"]) assert.equal(store.hasEndpointDeliveryReservation(id), true);
  await store.prepare(preparation());
  assert.deepEqual(persisted.requests["broken-request"], broken);
  const restarted = new AgentRequestStore(persistence);
  assert.equal(restarted.getEndpointDeliveryEvidenceStatus().available, true);
  assert.equal(restarted.hasEndpointDeliveryReservation("original-reply"), true);
});

test("damaged entries with incomplete reservation IDs disable owner absence proofs and writes", async () => {
  for (const raw of [
    { version: 1, requests: { broken: { id: "broken" } } },
    { version: 1, requests: { broken: { deliveryId: "known-id", pendingResponseDeliveryId: " invalid " } } },
    { version: 1, requests: { broken: { deliveryId: "known-id", response: {} } } },
    { version: 1, requests: {}, deliveries: { " invalid ": { deliveryId: "known-id" } } }
  ]) {
    let writes = 0; const store = new AgentRequestStore({ read: () => raw, write: () => { writes++; } });
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false);
    await assert.rejects(async () => await store.prepare(preparation())); assert.equal(writes, 0);
  }
});

test("an unreadable persistence implementation remains unavailable rather than becoming empty", async () => {
  let writes = 0;
  const store = new AgentRequestStore({ read: () => { throw new Error("fixture read failed"); }, write: () => { writes++; } });
  assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false);
  await assert.rejects(async () => await store.prepare(preparation())); assert.equal(writes, 0);
});

test("mismatched persisted request identities cannot overwrite healthy neighbors or release original reservations", async () => {
  for (const brokenFirst of [false, true]) {
    const row = (deliveryId: string) => ({ id: "same-request", deliveryId, status: "awaiting_response",
      ...preparation(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reminderCount: 0 });
    const healthy = row("first-original-send"), broken = row("second-original-send");
    const entries = [["same-request", healthy], ["different-key", broken]] as const;
    let persisted: any = { version: 1, requests: Object.fromEntries(brokenFirst ? [...entries].reverse() : entries) };
    const persistence = { read: () => persisted, write: (value: unknown) => { persisted = structuredClone(value); } };
    for (let restart = 0; restart < 2; restart++) {
      const store = new AgentRequestStore(persistence);
      assert.equal(store.getEndpointDeliveryEvidenceStatus().available, true);
      assert.equal(store.get("same-request")?.deliveryId, "first-original-send");
      assert.equal(store.hasEndpointDeliveryReservation("first-original-send"), true);
      assert.equal(store.hasEndpointDeliveryReservation("second-original-send"), true);
      await store.prepare(preparation());
      assert.deepEqual(persisted.requests["different-key"], broken);
      assert.equal(persisted.requests["same-request"].deliveryId, "first-original-send");
      await store.close();
    }
  }
});

test("persisted request and delivery identities are never trimmed or truncated into valid identities", async () => {
  const original = { id: "request", deliveryId: "original-delivery", status: "awaiting_response",
    ...preparation(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reminderCount: 0 };
  for (const id of [" request ", "x".repeat(101)]) {
    const broken = { ...original, id };
    let persisted: any = { version: 1, requests: { [id]: broken } };
    const store = new AgentRequestStore({ read: () => persisted, write: value => { persisted = structuredClone(value); } });
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, true);
    assert.equal(store.list().length, 0);
    assert.equal(store.hasEndpointDeliveryReservation("original-delivery"), true);
    await store.prepare(preparation());
    assert.deepEqual(persisted.requests[id], broken);
    await store.close();
  }
  for (const deliveryId of [" original-delivery ", "x".repeat(101)]) {
    const raw = { version: 1, requests: { request: { ...original, deliveryId } } };
    let writes = 0;
    const store = new AgentRequestStore({ read: () => raw, write: () => { writes++; } });
    assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false, "an unidentifiable reservation cannot prove absence");
    await assert.rejects(store.prepare(preparation()));
    assert.equal(writes, 0);
    await store.close();
  }
});
