import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverSessionOnce, sendAutomationSession } from "./sessionDelivery.js";
import type { AgentSessionDestination } from "../shared/agentDeliveryTarget.js";
const target: AgentSessionDestination = { kind: "session", agentAdapter: "codex", agentTargetId: "local:codex", sessionId: "task-one", sessionName: "Same name", workspace: "/workspace" };
const envelope = { messageSource: { type: "system" as const, eventType: "test", eventName: "Test", eventId: "event" }, messageContent: "message" };
const receipt = (id: string) => ({ delivery: { status: "delivered", deliveryId: id, targetThreadId: target.sessionId } });

test("concurrent and repeated delivery uses one send and persists its receipt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "intent.json"); let sends = 0;
  const request = async (payload: Record<string, unknown>) => { sends++; assert.equal(payload.agentTargetId, "local:codex"); await Promise.resolve(); return receipt("delivery-one"); };
  await Promise.all([1, 2].map(() => deliverSessionOnce(state, target, envelope, "delivery-one", request)));
  await deliverSessionOnce(state, target, envelope, "delivery-one", request);
  assert.equal(sends, 1);
  await assert.rejects(deliverSessionOnce(state, { ...target, sessionId: "other" }, envelope, "delivery-one", request), /refusing to redirect/);
});

test("a lost receipt is recovered on retry without resending", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "intent.json"); const calls: unknown[] = [];
  await assert.rejects(deliverSessionOnce(state, target, envelope, "delivery-one", async payload => { calls.push(payload.action); throw new Error("timeout"); }), /timeout/);
  await deliverSessionOnce(state, target, envelope, "delivery-one", async payload => {
    calls.push(payload.action); return { threadId: target.sessionId, delivery: { deliveryId: "delivery-one", state: "accepted" } };
  });
  assert.deepEqual(calls, ["send", "reconcile_delivery", "read"]);
});

test("remote calls omit local target identity and wrong-session receipts fail", async () => {
  const remote = { ...target, agentTargetId: "remote:node:agent" };
  await sendAutomationSession(remote, envelope, "delivery-one", async payload => {
    assert.equal(payload.agentTargetId, undefined); return receipt("delivery-one");
  }, { remote: true });
  await assert.rejects(sendAutomationSession(target, envelope, "delivery-one", async () => ({ delivery: { ...receipt("delivery-one").delivery, targetThreadId: "other" } })), /no confirmed receipt/);
});

test("Grok direct delivery freezes the group and identity without PC execution options", async () => {
  const group: AgentSessionDestination = { ...target, agentAdapter: "grokBot", agentTargetId: "local:grokBot",
    deliveryType: "group", sendMode: "identity", senderAgentId: "example-bot", senderAgentName: "Example" };
  await sendAutomationSession(group, { ...envelope, messageContent: "Example(123) : hello" }, "group-delivery", async payload => {
    assert.equal(payload.cwd, undefined);
    assert.equal(payload.model, undefined);
    assert.equal(payload.prompt, "Example(123) : hello");
    assert.deepEqual(payload.grokBotDelivery, { deliveryType: "group", sendMode: "identity", senderAgentId: "example-bot" });
    return receipt("group-delivery");
  }, { model: "local-only" });
});
