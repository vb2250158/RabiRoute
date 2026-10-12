import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { mapAgentSendReplyResult, prepareAgentSendRequest, type AgentSendRequest } from "../agentSend.js";
import { agentReplyDeliveryTrace, projectAgentReplyHistoryResult } from "../outbox.js";
import { durableDeliveryRequestDigest } from "./durableDeliveryIdempotency.js";
import { inspectOriginalAgentSendHistory, MAX_AGENT_SEND_HISTORY_BYTES } from "./agentSendHistoryVerification.js";
import { createAgentSendVerificationEvidenceVerifier } from "./agentSendVerificationEvidence.js";

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
  const trace = agentReplyDeliveryTrace(prepared.internal);
  const options = { logPath, traceReplyRequest: agentReplyDeliveryTrace,
    projectResult: projectAgentReplyHistoryResult, mapResult: mapAgentSendReplyResult };
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
    await f.write([f.line("group_file_uploaded", f.success), bad]); assert.equal((await f.inspect()).historyState, "damaged");
  }
  await fs.writeFile(f.logPath, f.line("group_file_uploaded", f.success)); assert.equal((await f.inspect()).historyState, "damaged");
});
test("missing, empty, oversized and unreadable history fail closed", async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).historyState, "missing");
  await fs.writeFile(f.logPath, ""); assert.equal((await f.inspect()).historyState, "request_not_found");
  const handle = await fs.open(f.logPath, "w"); await handle.truncate(MAX_AGENT_SEND_HISTORY_BYTES + 1); await handle.close();
  assert.equal((await f.inspect()).historyState, "oversized");
  await fs.rm(f.logPath); await fs.mkdir(f.logPath); assert.equal((await f.inspect()).historyState, "read_failed");
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
test("owner projection strips request, digest, caption and audit metadata", async t => {
  const f = await fixture(t, true);
  await f.write([f.line("group_file_uploaded", f.success), f.line("group_file_caption_sent", {
    ...f.success, sentMessageId: "example-caption", text: "example caption", request: f.prepared.internal,
    audit: { source: "example-internal-only" }, authorizationIncarnation: "example-private-incarnation"
  })]);
  const result = await f.inspect();
  assert.equal(result.terminalComplete, true);
  assert.equal(result.inspection.state, "completed");
  if (result.inspection.state !== "completed") assert.fail("must project a completed result");
  assert.deepEqual(result.inspection.result, mapAgentSendReplyResult({
    ...f.success, status: "sent", sentMessageId: "example-caption"
  }, f.request));
  for (const key of ["request", "deliveryRequestDigest", "text", "audit", "authorizationIncarnation"]) {
    assert.equal(Object.hasOwn(result.inspection.result, key), false);
  }
});
test("invalid business fields and draft history cannot prove delivery", async t => {
  const f = await fixture(t);
  for (const change of [{ targetType: "unsupported" }, { sentFileName: 7 }, { instanceId: {} }, { draft: {} }]) {
    await f.write([f.line("group_file_uploaded", { ...f.success, ...change })]);
    assert.equal((await f.inspect()).historyState, "damaged");
  }
});
test("managed upload reference preserves whole file and caption terminal proof", async t => {
  const f = await fixture(t, true);
  const request: AgentSendRequest = { ...f.request, payload: {
    type: "file", fileId: "11111111-1111-4111-8111-111111111111", fileSha256: "a".repeat(64), text: "example caption"
  } };
  const prepared = prepareAgentSendRequest(request);
  const trace = agentReplyDeliveryTrace(prepared.internal);
  const { deliveryId: _id, ...payload } = request;
  const line = (event: string, data: Record<string, unknown>) => JSON.stringify({ event, data: { ...trace, ...data } });
  await f.write([line("group_file_uploaded", f.success), line("group_file_caption_sent", {
    ...f.success, sentMessageId: "example-caption", text: "example caption"
  })]);
  const result = await inspectOriginalAgentSendHistory(request, durableDeliveryRequestDigest(payload), f.options);
  assert.equal(result.terminalComplete, true);
});

test("outer digest mismatch does not inspect or map history", async t => {
  const f = await fixture(t); await f.write([f.line("group_file_uploaded", f.success)]);
  await assert.rejects(() => inspectOriginalAgentSendHistory(f.request, "wrong", f.options), /not authoritative/);
});

test("readable absent request, requested-only and missing caption have distinct safe history states", async t => {
  const f = await fixture(t, true);
  await f.write([f.line("send_requested", { deliveryId: "other" })]);
  assert.equal((await f.inspect()).historyState, "request_not_found");
  await f.write([f.line("send_requested", { request: f.prepared.internal })]);
  const requested = await f.inspect();
  assert.equal(requested.historyState, "terminal_missing"); assert.equal(requested.inspection.state, "uncertain");
  await f.write([f.line("group_file_uploaded", f.success)]);
  const uploaded = await f.inspect();
  assert.equal(uploaded.historyState, "terminal_missing"); assert.equal(uploaded.inspection.state, "completed");
  assert.equal(uploaded.terminalComplete, undefined);
});
test("invalid UTF-8 is damaged and a log mutation during stable read is changed", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.logPath, Buffer.from([0xc3, 0x28, 0x0a]));
  assert.equal((await f.inspect()).historyState, "damaged");
  await f.write([f.line("group_file_uploaded", f.success)]);
  const stat = fs.stat;
  const replacement = t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === f.logPath) await fs.appendFile(f.logPath, "\n");
    return stat(...args);
  });
  assert.equal((await f.inspect()).historyState, "changed");
  replacement.mock.restore();
});
test("production inspect-only assembly reports legacy missing binding without borrowing current account", async t => {
  const f = await fixture(t);
  await f.write([f.line("group_file_uploaded", { ...f.success, routeProfileId: "example-route", groupId: "100001" })]);
  const before = await fs.readFile(f.logPath);
  const outcome = await createAgentSendVerificationEvidenceVerifier({ inspect: f.inspect })(f.request, {
    version: 1, deliveryId: f.prepared.deliveryId, requestDigest: f.digest, state: "uncertain", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z"
  });
  assert.deepEqual(outcome.evidence, { reason: "binding_missing", historicalTerminalProven: true, historyState: "completed",
    missingBindingFields: ["selfId", "bindingRevision"], deliveredNow: false, retryAllowed: false, sha256Verified: false, captionVerified: false });
  assert.equal(outcome.platformVerification, "unknown"); assert.equal(outcome.originalTerminalProven, undefined);
  assert.deepEqual(await fs.readFile(f.logPath), before);
  assert.ok(!JSON.stringify(outcome).includes(f.logPath));
});
test("only original upload can supply binding, not caption or requested record", async t => {
  const f = await fixture(t, true);
  const original = { routeProfileId: "example-route", groupId: "100001", selfId: "100002", bindingRevision: "example-revision" };
  await f.write([f.line("send_requested", { ...original, request: f.prepared.internal }), f.line("group_file_uploaded", f.success),
    f.line("group_file_caption_sent", { ...f.success, ...original, sentMessageId: "example-caption", text: "example caption" })]);
  assert.equal((await f.inspect()).originalBinding?.state, "missing");
  await f.write([f.line("group_file_uploaded", { ...f.success, ...original }),
    f.line("group_file_caption_sent", { ...f.success, sentMessageId: "example-caption", text: "example caption" })]);
  const history = await f.inspect();
  assert.equal(history.originalBinding?.state, "present");
  let reads = 0;
  const outcome = await createAgentSendVerificationEvidenceVerifier({ inspect: f.inspect, verifyCurrentPresence: async binding => {
    reads++; assert.equal(binding.selfId, "100002"); assert.equal(binding.bindingRevision, "example-revision");
    return { status: "present", reason: "exact_file_id", deliveredNow: false, retryAllowed: false, sha256Verified: false, captionVerified: false };
  } })(f.request, { version: 1, deliveryId: f.prepared.deliveryId, requestDigest: f.digest, state: "uncertain", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" });
  assert.equal(reads, 1); assert.equal(outcome.originalTerminalProven, true);
  assert.ok(!JSON.stringify(outcome).includes("100002")); assert.ok(!JSON.stringify(outcome).includes("example-revision"));
});
test("different original upload binding snapshots cannot be merged into a new binding", async t => {
  const f = await fixture(t);
  const original = { ...f.success, routeProfileId: "example-route", groupId: "100001", selfId: "100002", bindingRevision: "example-revision" };
  await f.write([f.line("group_file_uploaded", original), f.line("group_file_uploaded", { ...original, selfId: "100003" }), f.line("group_file_uploaded", original)]);
  assert.deepEqual((await f.inspect()).originalBinding, { state: "conflict" });
});
