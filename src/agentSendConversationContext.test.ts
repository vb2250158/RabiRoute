import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AgentSendConversationContextGuard } from "./agentSendConversationContext.js";
import { AgentSendConversationQueue } from "./agentSendConversationQueue.js";
import { conversationIndexForRecord } from "./conversationMessageCursor.js";
import { appendMessageContextToDir, conversationMessageWindow, messageContextArchiveIndexPath, messageContextCurrentPath, recentMessageContextItems, type MessageContextRecord } from "./messageContextStore.js";
import { agentSendIdempotencyPayload, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";
import { normalizeMessageAdapterPolicy } from "./shared/gatewayConfigModel.js";
import { ManagerReadWorkerPool } from "./manager/managerReadWorkerPool.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "send-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const role = path.join(root, "roles", "role");
  const options: AgentReplyOptions = { rootDir: root, rolesRoot: "roles", routeRoot: path.join(root, "routes"),
    runtimes: [{ id: "gateway", agentRoleId: "role", routeProfiles: [{ id: "route" }] }] };
  const request: AgentSendRequest = { deliveryId: "send-1", sender: { agentType: "codex", sessionId: "agent-A" },
    routeId: "route", channel: "napcat", params: { target: "group", groupId: "group-1", replyToMessageId: "" }, payload: { type: "text", text: "收到" } };
  const append = (text: string, patch: Partial<MessageContextRecord> = {}) => appendMessageContextToDir(role, {
    time: Math.floor(Date.now() / 1000), direction: "inbound", adapter: "napcat", gatewayId: "gateway", kind: "group",
    target: "group-1", text, messageId: `message-${text}`, ...patch
  }, { archiveCheck: false })!.record;
  return { root, role, options, request, append, guard: new AgentSendConversationContextGuard() };
}
function confirmation(request: AgentSendRequest, result: Awaited<ReturnType<AgentSendConversationContextGuard["evaluate"]>>) {
  return { ...request, conversationContext: { lastReadMessageIndex: result.context!.latestMessageIndex, confirmationToken: result.context!.confirmationToken } };
}

test("missing index returns latest 50; a fresh scoped AgentPacket cursor sends directly", async t => {
  const f = fixture(t);
  for (let i = 1; i <= 70; i++) f.append(String(i));
  const initial = (await f.guard.evaluate(f.request, f.options));
  assert.equal(initial.blocked, true);
  assert.equal(initial.context!.messages.length, 50);
  assert.equal(initial.context!.messages[0].text, "21");
  assert.equal((await f.guard.evaluate(confirmation(f.request, initial), f.options)).blocked, false);
  const record = f.append("new");
  const index = conversationIndexForRecord(f.role, record);
  const next = { ...f.request, deliveryId: "fresh", conversationContext: { lastReadMessageIndex: index } };
  assert.equal((await f.guard.evaluate(next, f.options)).blocked, false);
  assert.equal((await f.guard.evaluate({ ...next, routeId: "gateway", deliveryId: "alias-send" }, f.options)).blocked, false);
});

test("delta <=100 is complete, >100 is first/last 50 with exact omission and searchable range", async t => {
  const f = fixture(t); f.append("start");
  const first = (await f.guard.evaluate(f.request, f.options));
  for (let i = 1; i <= 130; i++) f.append(String(i));
  const result = (await f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: first.context!.latestMessageIndex } }, f.options));
  const c = result.context!;
  assert.equal(c.totalCount, 130); assert.equal(c.messages.length, 100); assert.equal(c.omittedCount, 30);
  assert.equal(c.messages[49].text, "50"); assert.equal(c.messages[50].text, "81"); assert.equal(c.messages[99].text, "130");
  assert.deepEqual(c.omittedRange, { afterSequence: 51, beforeSequence: 81 });
  const searched = recentMessageContextItems([f.role], { limit: 100, includeArchives: true, afterSequence: 51, beforeSequence: 81, query: "70" });
  assert.equal(searched[0].text, "70");
  const current = c.latestMessageIndex;
  for (let i = 1; i <= 100; i++) f.append(`next-${i}`);
  const exact = (await f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: current } }, f.options)).context!;
  assert.equal(exact.messages.length, 100); assert.equal(exact.omittedCount, 0);
});

test("new messages, changed text/sender/target and expired proofs require another confirmation", async t => {
  const f = fixture(t); f.append("one");
  const now = Date.now(); const first = (await f.guard.evaluate(f.request, f.options, now));
  const confirmed = confirmation(f.request, first);
  assert.equal((await f.guard.evaluate({ ...confirmed, payload: { type: "text", text: "changed" } }, f.options, now)).blocked, true);
  assert.equal((await f.guard.evaluate({ ...confirmed, sender: { agentType: "dsh", sessionId: "agent-B" } }, f.options, now)).blocked, true);
  assert.equal((await f.guard.evaluate(confirmed, f.options, now + 600_000)).blocked, true);
  f.append("two");
  const updated = (await f.guard.evaluate(confirmed, f.options, now));
  assert.equal(updated.blocked, true); assert.equal(updated.context!.messages[0].text, "two");
  assert.equal((await f.guard.evaluate(confirmation(f.request, updated), f.options, now)).blocked, false);
});

test("second call cannot omit a required proof; independent Agent caches never advance each other", async t => {
  const f = fixture(t); f.append("one");
  const initial = (await f.guard.evaluate(f.request, f.options));
  assert.equal((await f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: initial.context!.latestMessageIndex } }, f.options)).blocked, true);
  assert.equal((await f.guard.evaluate(confirmation(f.request, initial), f.options)).blocked, false);
  f.guard.rememberReturnedIndex(f.request, f.options, initial.context!.latestMessageIndex);
  assert.equal((await f.guard.evaluate({ ...f.request, deliveryId: "send-2" }, f.options)).blocked, false);
  const other = { ...f.request, sender: { agentType: "dsh", sessionId: "agent-B" } };
  assert.equal((await f.guard.evaluate(other, f.options)).context!.reason, "initial_context");
  f.append("two");
  assert.equal((await f.guard.evaluate({ ...f.request, deliveryId: "send-3" }, f.options)).context!.reason, "new_messages");
});

test("different conversations/accounts cannot share cursors or leak messages", async t => {
  const f = fixture(t); f.append("own"); f.append("private", { target: "group-2" });
  f.append("other-account", { instanceId: "other" });
  f.options.runtimes[0].napcatInstances = [{ id: "selected", enabled: true, httpUrl: "http://localhost", accessToken: "" }];
  const own = (await f.guard.evaluate(f.request, f.options));
  assert.deepEqual(own.context!.messages.map(x => x.text), ["own"]);
  const other = (await f.guard.evaluate({ ...f.request, params: { target: "group", groupId: "group-2", replyToMessageId: "" }, conversationContext: { lastReadMessageIndex: own.context!.latestMessageIndex } }, f.options));
  assert.equal(other.context!.reason, "invalid_index"); assert.deepEqual(other.context!.messages.map(x => x.text), ["private"]);
});

test("same mechanism covers all chat channels; plan feedback/playback remain structured actions", async t => {
  const f = fixture(t);
  for (const [channel, params, patch] of [
    ["wecom", { chatId: "chat" }, { adapter: "wecom", target: "chat", kind: "wecom" }],
    ["feishu", { chatId: "chat" }, { adapter: "feishu", target: "chat", kind: "feishu" }],
    ["weixin", { sessionId: "session" }, { adapter: "weixin", sessionId: "session", kind: "private" }],
    ["speech", { sessionId: "session" }, { adapter: "speech", sessionId: "session", kind: "voice" }],
    ["fennenote", { sessionId: "session", mode: "message" }, { adapter: "fennenote", sessionId: "session", kind: "voice" }],
    ["role_panel", { roleId: "role" }, { adapter: "rolePanel", target: "role", kind: "role_panel" }],
    ["rabilink", { proactive: true, targetDeviceIds: ["device"] }, { adapter: "wearable", transport: "rabilink", sourceDeviceId: "device", kind: "voice" }]
  ] as const) {
    f.append(channel, patch);
    const request = { ...f.request, deliveryId: channel, channel, params };
    const result = (await f.guard.evaluate(request, f.options));
    assert.equal(result.blocked, true, channel); assert.equal(result.context!.messages.at(-1)!.text, channel);
    assert.equal((await f.guard.evaluate(confirmation(request, result), f.options)).blocked, false, channel);
  }
  assert.equal((await f.guard.evaluate({ ...f.request, channel: "plan_feedback", params: { roleId: "role", planId: "plan", kind: "guidance" } }, f.options)).context, undefined);
  assert.equal((await f.guard.evaluate({ ...f.request, channel: "fennenote", params: { sessionId: "session", mode: "playback" } }, f.options)).context, undefined);
});

test("archive boundary keeps exact delta, corrupt authoritative records fail closed", async t => {
  const f = fixture(t);
  f.append("old", { time: 1 });
  const before = (await f.guard.evaluate(f.request, f.options)).context!.latestMessageIndex;
  appendMessageContextToDir(f.role, { time: 2, direction: "inbound", adapter: "napcat", gatewayId: "gateway", target: "group-1", kind: "group", text: "archived" }, { now: 1_800_000_000_000 });
  f.append("new");
  const result = (await f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: before } }, f.options));
  assert.deepEqual(result.context!.messages.map(x => x.text), ["archived", "new"]);
  fs.appendFileSync(messageContextCurrentPath(f.role), "{broken}\n");
  await assert.rejects(async () => (await f.guard.evaluate(f.request, f.options)));
});

test("cold empty ledgers remain usable and initialized ledgers missing current fail closed", async t => {
  const f = fixture(t);
  const cold = await f.guard.evaluate(f.request, f.options);
  assert.deepEqual(cold.context!.messages, []);
  assert.equal(cold.context!.totalCount, 0);
  assert.equal((await f.guard.evaluate(confirmation(f.request, cold), f.options)).blocked, false);
  assert.equal(fs.existsSync(messageContextArchiveIndexPath(f.role)), false);

  f.append("persisted");
  const initialized = await f.guard.evaluate(f.request, f.options);
  assert.equal(fs.existsSync(messageContextArchiveIndexPath(f.role)), true);
  fs.unlinkSync(messageContextCurrentPath(f.role));
  assert.throws(() => conversationMessageWindow(f.role, { matches: () => true, limit: 50 }), /current file is missing/);
  await assert.rejects(() => f.guard.evaluate(confirmation(f.request, initialized), f.options), /current file is missing/);
});

test("missing archive indexes cannot omit archived messages or turn archive-only ledgers into empty history", async t => {
  for (const removeCurrent of [false, true]) {
    const f = fixture(t);
    f.append("old", { time: 1 });
    appendMessageContextToDir(f.role, { time: 2, direction: "inbound", adapter: "napcat", gatewayId: "gateway", target: "group-1", kind: "group", text: "new" }, { now: 1_800_000_000_000 });
    const indexPath = messageContextArchiveIndexPath(f.role);
    assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).archives.length, 1);
    fs.unlinkSync(indexPath);
    if (removeCurrent) fs.unlinkSync(messageContextCurrentPath(f.role));
    assert.throws(() => conversationMessageWindow(f.role, { matches: () => true, afterSequence: 0, limit: 50 }), /archive index is missing/);
    await assert.rejects(() => f.guard.searchHistory(f.request, f.options, { afterSequence: 0, limit: 50 }), /archive index is missing/);
    await assert.rejects(() => f.guard.evaluate(f.request, f.options), /archive index is missing/);
  }
});

test("invalid archive indexes fail history queries and send checks", async t => {
  for (const invalidIndex of ["{broken}", JSON.stringify({ archives: [{ file: "../outside.jsonl", firstSequence: 1, lastSequence: 1 }] })]) {
    const f = fixture(t);
    f.append("persisted");
    fs.writeFileSync(messageContextArchiveIndexPath(f.role), invalidIndex);
    assert.throws(() => conversationMessageWindow(f.role, { matches: () => true, limit: 50 }));
    await assert.rejects(() => f.guard.searchHistory(f.request, f.options, { limit: 50 }));
    await assert.rejects(() => f.guard.evaluate(f.request, f.options));
  }
});

test("missing archive shards fail history queries and incremental send checks", async t => {
  const f = fixture(t);
  f.append("old", { time: 1 });
  const before = (await f.guard.evaluate(f.request, f.options)).context!.latestMessageIndex.replace(/\.\d+$/, ".0");
  appendMessageContextToDir(f.role, { time: 2, direction: "inbound", adapter: "napcat", gatewayId: "gateway", target: "group-1", kind: "group", text: "new" }, { now: 1_800_000_000_000 });
  const indexPath = messageContextArchiveIndexPath(f.role);
  const archive = JSON.parse(fs.readFileSync(indexPath, "utf8")).archives[0];
  fs.unlinkSync(path.join(path.dirname(indexPath), archive.file));
  assert.throws(() => conversationMessageWindow(f.role, { matches: () => true, afterSequence: 0, limit: 50 }), { code: "ENOENT" });
  await assert.rejects(() => f.guard.searchHistory(f.request, f.options, { afterSequence: 0, limit: 50 }), { code: "ENOENT" });
  await assert.rejects(() => f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: before } }, f.options), { code: "ENOENT" });
});

test("config defaults/odd limits, invalid contract fields and transient idempotency fields", async t => {
  const f = fixture(t);
  assert.deepEqual(normalizeMessageAdapterPolicy({}, "wecom").conversationReview, { initialMessageCount: 50, maxIncrementalMessages: 100 });
  assert.throws(() => normalizeMessageAdapterPolicy({ conversationReview: { initialMessageCount: 0 } }, "napcat"));
  f.options.runtimes[0].messageAdapterPolicies = { napcat: { conversationReview: { initialMessageCount: 3, maxIncrementalMessages: 5 } } };
  f.append("start"); const first = (await f.guard.evaluate(f.request, f.options));
  for (let i = 0; i < 9; i++) f.append(String(i));
  const delta = (await f.guard.evaluate({ ...f.request, conversationContext: { lastReadMessageIndex: first.context!.latestMessageIndex } }, f.options)).context!;
  assert.deepEqual(delta.messages.map(x => x.text), ["0", "1", "2", "7", "8"]);
  assert.throws(() => prepareAgentSendRequest({ ...f.request, conversationContext: [] }), /object/);
  assert.throws(() => prepareAgentSendRequest({ ...f.request, conversationContext: { other: true } }), /unsupported/);
  assert.deepEqual(agentSendIdempotencyPayload(confirmation(f.request, first)), agentSendIdempotencyPayload(f.request));
  assert.equal(conversationMessageWindow(f.role, { matches: x => x.adapter === "napcat", limit: 3 }).entries.length, 3);
});

test("concurrent Agents: same chat waits and sees earlier reply; other chat proceeds; failure releases queue", async t => {
  const f = fixture(t); f.append("start");
  const queue = new AgentSendConversationQueue();
  const index = (await f.guard.evaluate(f.request, f.options)).context!.latestMessageIndex;
  const a = { ...f.request, conversationContext: { lastReadMessageIndex: index } };
  const b = { ...a, deliveryId: "B", sender: { agentType: "dsh", sessionId: "agent-B" } };
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const starting = new Promise<void>(resolve => { started = resolve; });
  const first = queue.run(f.guard.serializationKey(a, f.options), async () => { started(); await barrier; f.append("reply-A", { direction: "outbound" }); });
  await starting;
  let secondRan = false;
  const second = queue.run(f.guard.serializationKey(b, f.options), async () => { secondRan = true; return (await f.guard.evaluate(b, f.options)); });
  await queue.run("another-chat", async () => { assert.equal(secondRan, false); });
  release(); await first;
  const result = await second; assert.equal(result.blocked, true); assert.equal(result.context!.messages[0].text, "reply-A");
  await assert.rejects(queue.run("failure", async () => { throw new Error("failed"); }));
  assert.equal(await queue.run("failure", async () => "released"), "released");
});

test("bounded read workers serve parallel Agent contexts without sharing confirmation state", async t => {
  const f = fixture(t); f.append("worker-message");
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 2, timeoutMs: 30_000 });
  t.after(async () => { await pool.stop(); });
  const guard = new AgentSendConversationContextGuard((dataDir, filter, query) => pool.run({ type: "conversation_window", dataDir, filter, query }));
  const other = { ...f.request, sender: { agentType: "dsh", sessionId: "agent-B" } };
  const [a, b] = await Promise.all([guard.evaluate(f.request, f.options), guard.evaluate(other, f.options)]);
  assert.deepEqual(a.context!.messages.map(item => item.text), ["worker-message"]);
  assert.equal((await guard.evaluate(confirmation(other, a), f.options)).blocked, true);
  assert.equal((await guard.evaluate(confirmation(other, b), f.options)).blocked, false);
  const history = await guard.searchHistory(f.request, f.options, { query: "worker", limit: 50, afterSequence: 0 });
  assert.equal(history.entries[0].text, "worker-message");
});
