import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrokBotAdapter, deliverWithTransportReceipt, resolveGrokBotConfiguredSession } from "./grokBotAdapter.js";
import { encodeGrokBotSessionId, GrokBotError, type GrokBotSendInput, type GrokBotSendReceipt, type GrokBotSendStatus } from "./grokBotClient.js";
import type { RabiDeliveryEnvelope } from "../shared/rabiMessage.js";

const configuration = { agentId: "fixture-owner", sessionId: "fixture-session" };
const envelope: RabiDeliveryEnvelope = { messageSource: { type: "system", eventType: "fixture", eventName: "Fixture delivery", eventId: "fixture-event" },
  messageContent: "Fixture content", contextBlocks: ["Fixture context"], controlBlocks: ["Fixture reply contract"], deliveryId: "fixture-delivery", sentAt: "2026-10-14T00:00:00Z" };

test("exported transport preserves plain prompt, identity and caller journal key across retries and read-only reconciliation", async t => {
  const config = await fixtureConfiguration(t);
  const bound = resolveGrokBotConfiguredSession(config);
  const sends: GrokBotSendInput[] = [];
  const client = fixtureClient(async input => { sends.push(input); return { ...input, accepted: true, duplicate: false, recovered: false }; });
  const grokBotDelivery = { deliveryType: "private" as const, sendMode: "identity" as const, senderAgentId: "sender" };
  await deliverWithTransportReceipt(client, config.dataDir, bound, "caller-key", "Plain text", { grokBotDelivery });
  assert.equal(sends[0].text, "Plain text");
  assert.equal(sends[0].fromAgentId, "sender");
  const before = await fs.readdir(config.dataDir, { recursive: true });
  await deliverWithTransportReceipt(client, config.dataDir, bound, "caller-key", undefined, { grokBotDelivery, reconcileOnly: true });
  assert.deepEqual(await fs.readdir(config.dataDir, { recursive: true }), before);
  assert.equal(sends.length, 1);
  await assert.rejects(deliverWithTransportReceipt(client, config.dataDir, bound, "caller-key", "Plain text",
    { grokBotDelivery: { ...grokBotDelivery, senderAgentId: "other" } }), /GROK_BOT_DELIVERY_ID_CONFLICT/);
  await assert.rejects(deliverWithTransportReceipt(client, config.dataDir, bound, "missing-key", undefined,
    { grokBotDelivery, reconcileOnly: true }), /GROK_BOT_DELIVERY_NOT_FOUND/);
  assert.equal(sends.length, 1);
});

test("reconcile reads unresolved attempt and native status without sending or changing journal files", async t => {
  const config = await fixtureConfiguration(t), bound = resolveGrokBotConfiguredSession(config);
  let sends = 0, queries = 0;
  const client = fixtureClient(async () => { sends += 1; throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true }); },
    async () => { queries += 1; return { status: "accepted" }; });
  const options = { grokBotDelivery: { deliveryType: "group" as const, sendMode: "direct" as const } };
  await assert.rejects(deliverWithTransportReceipt(client, config.dataDir, bound, "key", "Plain text", options));
  const files = await fs.readdir(config.dataDir, { recursive: true });
  const attempt = files.find(file => file.endsWith(".attempt.json"))!;
  const before = await fs.readFile(path.join(config.dataDir, attempt), "utf8");
  const receipt = await deliverWithTransportReceipt(client, config.dataDir, bound, "key", undefined, { ...options, reconcileOnly: true });
  assert.equal(receipt.recovered, true);
  assert.equal(sends, 1); assert.equal(queries, 1);
  assert.deepEqual(await fs.readdir(config.dataDir, { recursive: true }), files);
  assert.equal(await fs.readFile(path.join(config.dataDir, attempt), "utf8"), before);
});
async function fixtureConfiguration(t: TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-route-fixture-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { ...configuration, dataDir };
}
function fixtureClient(sendNative: (input: GrokBotSendInput) => Promise<GrokBotSendReceipt>,
  getSendStatus: () => Promise<GrokBotSendStatus> = async () => ({ status: "not-found" })) {
  return { sendNative, getSendStatus, profileStatus: async () => ({ signedIn: true as const, accountScope: "fixture-account", profilePath: "fixture-profile" }) };
}
test("adapter preserves envelope source/context/control and exact owner session", async t => {
  const bound = await fixtureConfiguration(t);
  const states: Record<string, unknown>[] = [];
  const sends: GrokBotSendInput[] = [];
  const adapter = createGrokBotAdapter(bound, { writeState: async state => { states.push(state); }, reportState: () => {},
    client: fixtureClient(async input => { sends.push(input); return { ...input, accepted: true, duplicate: false, recovered: false }; }) });
  await adapter.deliver(envelope);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sessionId, configuration.sessionId);
  assert.match(sends[0].messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(states.at(-1)?.deliveryId, envelope.deliveryId);
  assert.equal(states.at(-1)?.messageId, sends[0].messageId);
  for (const text of ["Fixture delivery", "Fixture content", "Fixture context", "Fixture reply contract"]) assert.ok(sends[0].text.includes(text));
  assert.equal(states.at(-1)?.ownerAccepted, true);
  assert.equal(states.at(-1)?.status, "accepted");
  assert.equal(states.at(-1)?.monitorThreadId, encodeGrokBotSessionId(configuration.agentId, configuration.sessionId));
});
test("concurrent same delivery uses single send and rejects changed content", async t => {
  const bound = await fixtureConfiguration(t);
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  let calls = 0;
  const adapter = createGrokBotAdapter(bound, { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async input => {
    calls += 1; await pending; return { ...input, accepted: true, duplicate: false, recovered: false };
  }) });
  const first = adapter.deliver(envelope), second = adapter.deliver(envelope);
  await assert.rejects(adapter.deliver({ ...envelope, messageContent: "Changed" }), /GROK_BOT_DELIVERY_ID_CONFLICT/);
  resolve(); await Promise.all([first, second]);
  assert.equal(calls, 1);
});
test("unconfirmed owner receipt writes uncertain state, without retry/fallback", async t => {
  const bound = await fixtureConfiguration(t);
  const states: Record<string, unknown>[] = [];
  let calls = 0;
  const adapter = createGrokBotAdapter(bound, { writeState: async state => { states.push(state); }, reportState: () => {}, client: fixtureClient(async () => {
    calls += 1; throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
  }) });
  await assert.rejects(adapter.deliver(envelope), /GROK_BOT_DELIVERY_UNCONFIRMED/);
  assert.equal(calls, 1);
  assert.equal(states.at(-1)?.status, "result-unknown");
});
test("missing target/delivery and mismatched canonical owner fail before transport", async t => {
  const bound = await fixtureConfiguration(t);
  assert.throws(() => resolveGrokBotConfiguredSession({ sessionId: encodeGrokBotSessionId("owner-a", "session"), agentId: "owner-b" }), /GROK_BOT_SESSION_OWNER_MISMATCH/);
  const states: Record<string, unknown>[] = [];
  const adapter = createGrokBotAdapter(bound, { writeState: async state => { states.push(state); }, reportState: () => {},
    client: fixtureClient(async () => { throw new Error("should not send"); }) });
  await assert.rejects(adapter.deliver({ ...envelope, deliveryId: undefined }), /GROK_BOT_DELIVERY_ID_REQUIRED/);
  assert.equal(states.at(-1)?.status, "failed");
});
test("failed state persistence after acceptance preserves owner evidence and never retries", async t => {
  const bound = await fixtureConfiguration(t);
  const reports: Record<string, unknown>[] = [];
  let calls = 0;
  const adapter = createGrokBotAdapter(bound, { writeState: async state => {
    if (state.status !== "delivering") throw new Error("fixture private storage path");
  }, reportState: state => { reports.push(state); }, client: fixtureClient(async input => {
    calls += 1; return { ...input, accepted: true, recovered: false, duplicate: false };
  }) });
  await assert.rejects(adapter.deliver(envelope), (error: unknown) => error instanceof GrokBotError && error.uncertain && error.code === "GROK_BOT_RECEIPT_STATE_UNCONFIRMED");
  assert.equal(calls, 1);
  assert.equal(reports.at(-1)?.ownerAccepted, true);
  assert.equal(reports.at(-1)?.statePersistenceError, "GROK_BOT_STATE_UNAVAILABLE");
});
test("state persistence failure before transport fails with a closed diagnostic", async t => {
  const bound = await fixtureConfiguration(t);
  let calls = 0;
  const adapter = createGrokBotAdapter(bound, { writeState: async () => { throw new Error("fixture private storage path"); }, reportState: () => {},
    client: fixtureClient(async input => { calls += 1; return { ...input, accepted: true, recovered: false, duplicate: false }; }) });
  await assert.rejects(adapter.deliver(envelope), /GROK_BOT_STATE_UNAVAILABLE/);
  assert.equal(calls, 0);
});
test("sequential Route delivery and adapter restart reuse the accepted durable receipt", async t => {
  const bound = await fixtureConfiguration(t);
  let sends = 0;
  const dependencies = { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async (input: GrokBotSendInput) => {
    sends += 1; return { ...input, accepted: true, recovered: false, duplicate: false };
  }) };
  const first = createGrokBotAdapter(bound, dependencies);
  await first.deliver(envelope); await first.deliver(envelope);
  await createGrokBotAdapter(bound, dependencies).deliver(envelope);
  assert.equal(sends, 1);
  await assert.rejects(createGrokBotAdapter(bound, dependencies).deliver({ ...envelope, messageContent: "Changed after acceptance" }), /GROK_BOT_DELIVERY_ID_CONFLICT/);
  assert.equal(sends, 1);
});
test("uncertain Route attempt survives restart and NOT_FOUND cannot cause resend", async t => {
  const bound = await fixtureConfiguration(t);
  let sends = 0, queries = 0;
  const dependencies = { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async () => {
    sends += 1; throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
  }, async () => { queries += 1; return { status: "not-found" }; }) };
  await assert.rejects(createGrokBotAdapter(bound, dependencies).deliver(envelope), /GROK_BOT_DELIVERY_UNCONFIRMED/);
  await assert.rejects(createGrokBotAdapter(bound, dependencies).deliver(envelope), /GROK_BOT_DELIVERY_UNCONFIRMED/);
  assert.equal(sends, 1);
  assert.equal(queries, 1);
});
test("attempt persistence failure stops before native HTTP", async t => {
  const bound = await fixtureConfiguration(t);
  await fs.writeFile(path.join(bound.dataDir, "grokbot-transport-receipts"), "fixture obstacle");
  let sends = 0;
  const adapter = createGrokBotAdapter(bound, { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async input => {
    sends += 1; return { ...input, accepted: true, recovered: false, duplicate: false };
  }) });
  await assert.rejects(adapter.deliver(envelope), /GROK_BOT_JOURNAL_UNAVAILABLE/);
  assert.equal(sends, 0);
});
test("uncertain native attempt recovers one accepted receipt after restart and keeps message text out of journal", async t => {
  const bound = await fixtureConfiguration(t);
  let sends = 0, queries = 0;
  const dependencies = { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async () => {
    sends += 1; throw new Error("fixture private transport failure");
  }, async () => { queries += 1; return { status: "accepted", echoEntryId: "fixture-echo" }; }) };
  await assert.rejects(createGrokBotAdapter(bound, dependencies).deliver(envelope), (error: unknown) => error instanceof GrokBotError && error.uncertain);
  const restarted = createGrokBotAdapter(bound, dependencies);
  await restarted.deliver(envelope); await restarted.deliver(envelope);
  assert.equal(sends, 1); assert.equal(queries, 1);
  const shards = await fs.readdir(path.join(bound.dataDir, "grokbot-transport-receipts"));
  const directory = path.join(bound.dataDir, "grokbot-transport-receipts", shards[0]);
  const files = await fs.readdir(directory);
  assert.equal(files.filter(name => name.endsWith(".attempt.json")).length, 0);
  assert.equal(files.filter(name => name.endsWith(".receipt.json")).length, 1);
  const record = await fs.readFile(path.join(directory, files[0]), "utf8");
  assert.equal(record.includes(envelope.messageContent), false);
  assert.equal(record.includes("Fixture reply contract"), false);
});
test("two Route adapter instances share one transport attempt", async t => {
  const bound = await fixtureConfiguration(t);
  let started!: () => void, release!: () => void;
  const firstStarted = new Promise<void>(done => { started = done; });
  const pending = new Promise<void>(done => { release = done; });
  let sends = 0;
  const dependencies = { writeState: async () => {}, reportState: () => {}, client: fixtureClient(async (input: GrokBotSendInput) => {
    sends += 1; started(); await pending; return { ...input, accepted: true, recovered: false, duplicate: false };
  }) };
  const first = createGrokBotAdapter(bound, dependencies).deliver(envelope);
  await firstStarted;
  const second = createGrokBotAdapter(bound, dependencies).deliver(envelope);
  release(); await Promise.all([first, second]);
  assert.equal(sends, 1);
});
