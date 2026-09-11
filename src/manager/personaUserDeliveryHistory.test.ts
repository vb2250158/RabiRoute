import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import { readPersonaChatHistory } from "../personaChatHistory.js";
import { recordPersonaUserDelivery } from "./personaUserDeliveryHistory.js";

const feedback: PlanFeedbackRecord = {
  id: "feedback", roleId: "Example", planId: "plan", planTitle: "Example plan",
  kind: "guidance", author: "user", source: "webgui", text: "问题：目标等级？\n回答：30级\n补充说明：请核对原方案。",
  attachments: [], planAttachments: [], createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", deliveryStatus: "pending"
};
const result = (status: string, deliveryId = "delivery") => ({ statusCode: 202, data: {
  threadId: "actual-target", thread: { title: "Actual task" }, delivery: { deliveryId, status }
} });

test("submitted user feedback records answer text and actual target once across retries", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "user-chat-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let events = 0;
  const changed = () => { events++; };
  await recordPersonaUserDelivery(dir, feedback, result("delivered"), changed);
  await recordPersonaUserDelivery(dir, feedback, result("delivered", "retry-delivery"), changed);
  const entries = (await readPersonaChatHistory(dir)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "user_delivery");
  assert.equal(entries[0].text, feedback.text);
  assert.equal(entries[0].targetSessionId, "actual-target");
  assert.equal(entries[0].deliveryId, "delivery");
  assert.equal(entries[0].sourceLabel, "webgui");
  assert.equal(entries[0].feedbackId, feedback.id);
  assert.equal(events, 1);
});

test("save-only, Agent and failed sends are excluded; unconfirmed user delivery is labeled", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "user-chat-boundary-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const changed = () => {};
  await recordPersonaUserDelivery(dir, { ...feedback, deliveryStatus: "record_only" }, result("delivered"), changed);
  await recordPersonaUserDelivery(dir, { ...feedback, author: "agent" }, result("delivered"), changed);
  await recordPersonaUserDelivery(dir, feedback, result("failed"), changed);
  assert.equal((await readPersonaChatHistory(dir)).entries.length, 0);
  await recordPersonaUserDelivery(dir, { ...feedback, text: "", attachments: [{name:"evidence.png",kind:"image",path:"local",size:3,sha256:"test"}] }, result("unconfirmed"), changed);
  const entry = (await readPersonaChatHistory(dir)).entries[0];
  assert.equal(entry.deliveryStatus, "unconfirmed");
  assert.match(entry.text, /evidence.png/);
});
