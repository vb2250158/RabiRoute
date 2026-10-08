import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { prepareAgentSendRequest, type AgentSendRequest } from "../agentSend.js";
import { durableDeliveryRequestDigest } from "./durableDeliveryIdempotency.js";
import { inspectOriginalAgentSendHistory, MAX_AGENT_SEND_HISTORY_BYTES } from "./agentSendHistoryVerification.js";

// Isolated test capability mirrors the existing Outbox canonicalization; production
// must inject the owner capability rather than this fixture implementation.
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
async function fixture(t: TestContext, caption = false, textPayload = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "send-history-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "outbox.jsonl");
  const request: AgentSendRequest = { deliveryId: "example-delivery", sender: { agentType: "example", sessionId: "example-session" },
    routeId: "example-route", channel: "napcat", params: { target: "group", groupId: "100001", replyToMessageId: "" },
    payload: textPayload ? { type: "text", text: "example text" } : { type: "file", path: "example.pdf", ...(caption ? { text: "example caption" } : {}) } };
  const prepared = prepareAgentSendRequest(request);
  const { deliveryId: _id, ...payload } = request;
  const digest = durableDeliveryRequestDigest(payload);
  const traceReplyRequest = (internal: typeof prepared.internal) => ({ deliveryId: String(internal.deliveryId),
    deliveryRequestDigest: createHash("sha256").update(stable(internal)).digest("hex") });
  const trace = traceReplyRequest(prepared.internal);
  const options = { logPath, traceReplyRequest, mapResult: (result: import("../outbox.js").AgentReplyResult) => ({ ...result,
    deliveryId: prepared.deliveryId, sender: prepared.sender, channel: prepared.channel, routeId: prepared.routeId, target: prepared.target }) };
  const line = (event: string, data: Record<string, unknown> = {}) => JSON.stringify({ event, data: { ...trace, ...data } });
  const success = { ok: true, status: "sent", sentFileId: "example-file", instanceId: "example-instance" };
  const inspect = () => inspectOriginalAgentSendHistory(request, digest, options);
  const write = (lines: string[]) => fs.writeFile(logPath, `${lines.join("\n")}\n`);
  return { root, logPath, request, prepared, digest, options, line, success, inspect, write };
}

test("same ID different digest outranks completed in both orders and damaged lines", async t => {
  const f = await fixture(t);
  for (const lines of [
    [f.line("group_file_uploaded", f.success), f.line("send_requested", { deliveryRequestDigest: "different" })],
    [f.line("send_requested", { deliveryRequestDigest: "different" }), "{broken", f.line("group_file_uploaded", f.success)]
  ]) { await f.write(lines); const result = await f.inspect(); assert.equal(result.historyConflict, true); assert.equal(result.inspection.state, "uncertain"); assert.equal(result.terminalComplete, undefined); }
});
test("damaged JSON, malformed shape, missing digest and truncated tail stay unknown", async t => {
  const f = await fixture(t);
  for (const bad of ["{broken", "null", JSON.stringify({ event: "send_requested", data: { deliveryId: "example-delivery" } })]) {
    await f.write([f.line("group_file_uploaded", f.success), bad]); await assert.rejects(f.inspect, /not authoritative/);
  }
  await fs.writeFile(f.logPath, f.line("group_file_uploaded", f.success)); await assert.rejects(f.inspect, /not authoritative/);
});
test("missing, empty, oversized and unreadable history fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(f.inspect, /not authoritative/);
  await fs.writeFile(f.logPath, ""); await assert.rejects(f.inspect, /not authoritative/);
  const handle = await fs.open(f.logPath, "w"); await handle.truncate(MAX_AGENT_SEND_HISTORY_BYTES + 1); await handle.close();
  await assert.rejects(f.inspect, /not authoritative/);
  await fs.rm(f.logPath); await fs.mkdir(f.logPath); await assert.rejects(f.inspect, /not authoritative/);
});
test("upload alone cannot complete a file caption; matching upload plus caption can", async t => {
  const f = await fixture(t, true);
  await f.write([f.line("group_file_uploaded", f.success)]);
  assert.equal((await f.inspect()).terminalComplete, undefined);
  await f.write([f.line("group_file_uploaded", f.success), f.line("group_file_caption_sent", { ...f.success, sentMessageId: "example-caption", text: "example caption" })]);
  const result = await f.inspect(); assert.equal(result.terminalComplete, true); assert.equal(result.inspection.state, "completed");
  if (result.inspection.state === "completed") assert.equal(result.inspection.result.sentMessageId, "example-caption");
  for (const change of [{ sentFileId: "other" }, { text: "wrong" }, { sentMessageId: "" }]) {
    await f.write([f.line("group_file_uploaded", f.success), f.line("group_file_caption_sent", { ...f.success, text: "example caption", sentMessageId: "example-caption", ...change })]);
    assert.equal((await f.inspect()).terminalComplete, undefined);
  }
});
test("legal whole terminal file and text preserve outer result mapping", async t => {
  for (const textPayload of [false, true]) {
    const f = await fixture(t, false, textPayload);
    await f.write([f.line("send_requested", { request: f.prepared.internal }), f.line(textPayload ? "reply_sent" : "group_file_uploaded", { ...f.success, ...(textPayload ? { sentMessageId: "example-message" } : {}) })]);
    const result = await f.inspect(); assert.equal(result.historyConflict, false); assert.equal(result.requestDigest, f.digest); assert.equal(result.terminalComplete, true);
    if (result.inspection.state === "completed") assert.deepEqual(result.inspection.result.sender, f.prepared.sender);
  }
});
test("caption failed after upload and unrecognized terminal events never prove completion", async t => {
  const f = await fixture(t, true);
  for (const event of ["group_file_caption_failed", "send_file_success"]) {
    await f.write([f.line("group_file_uploaded", f.success), f.line(event, f.success)]); assert.equal((await f.inspect()).terminalComplete, undefined);
  }
});
test("outer digest mismatch does not inspect or map history", async t => {
  const f = await fixture(t); await f.write([f.line("group_file_uploaded", f.success)]);
  await assert.rejects(() => inspectOriginalAgentSendHistory(f.request, "wrong", f.options), /not authoritative/);
});
