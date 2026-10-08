import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import { durableDeliveryReceiptPath, durableDeliveryRequestDigest, type DurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import { settleAgentSendDelivery, verifyAgentSendDelivery, type AgentSendVerification } from "./agentSendReconciliation.js";

function fixture(t: test.TestContext, caption = false) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-send-reconciliation-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const deliveryId = caption ? "example-caption-delivery" : "example-file-delivery";
  const request: AgentSendRequest = { deliveryId, sender: { agentType: "message_processing", sessionId: "example-session" },
    routeId: "example-route", channel: "napcat", params: { target: "group", groupId: "100001", replyToMessageId: "example-source-message" },
    payload: { type: "file", path: "example-document.pdf", ...(caption ? { text: "example caption" } : {}) } };
  const prepared = prepareAgentSendRequest(request);
  const { deliveryId: _id, ...payload } = request;
  const result: AgentSendResult = { ok: true, status: "sent", deliveryId, sender: prepared.sender,
    channel: prepared.channel, routeId: prepared.routeId, target: JSON.parse(JSON.stringify(prepared.target)),
    sentFileId: "example-platform-file", sentFileName: "example-document.pdf", ...(caption ? { sentMessageId: "example-caption-message" } : {}) };
  const receipt: DurableDeliveryReceipt<AgentSendResult> = { version: 1, deliveryId,
    requestDigest: durableDeliveryRequestDigest(payload), state: "sending", createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z", executionId: "example-execution", ownerHost: "example-other-host",
    ownerPid: 1, leaseExpiresAt: "2000-01-01T00:00:00.000Z" };
  const file = durableDeliveryReceiptPath(rootDir, "agent-send-idempotency", deliveryId);
  const save = (value = receipt) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  save();
  const proof: AgentSendVerification = { platformVerification: "present", evidence: { source: "isolated-history" }, originalTerminalProven: true, originalResult: result };
  const options = { rootDir, verify: async () => proof };
  return { deliveryId, request, result, receipt, file, save, proof, options };
}
for (const caption of [false, true]) test(`historical sent and stale sending: ${caption ? "file plus caption" : "file only"}`, async t => {
  const f = fixture(t, caption);
  const before = fs.readFileSync(f.file, "utf8");
  const verified = await verifyAgentSendDelivery(f.deliveryId, f.request, f.options);
  assert.equal(verified.body.platformVerification, "present");
  assert.equal(verified.body.settlement, "not_attempted");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  const settled = await settleAgentSendDelivery(f.deliveryId, f.request, f.options);
  assert.equal(settled.body.settlement, "committed");
  assert.equal(settled.body.deliveredNow, false);
  assert.equal(settled.body.retryAllowed, false);
  assert.deepEqual(settled.body.originalResult, f.result);
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.deliveryId, f.deliveryId);
  assert.equal(saved.requestDigest, f.receipt.requestDigest);
  assert.equal(saved.createdAt, f.receipt.createdAt);
  assert.deepEqual(saved.result, f.result);
  assert.equal(saved.executionId, undefined);
});
test("presence and incomplete caption proof cannot settle", async t => {
  const f = fixture(t, true); const before = fs.readFileSync(f.file, "utf8");
  for (const proof of [
    { platformVerification: "present" as const, evidence: {} },
    { ...f.proof, originalTerminalProven: undefined },
    { ...f.proof, originalResult: { ...f.result, deliveryId: "other-id" } },
    { ...f.proof, originalResult: { ...f.result, sentMessageId: undefined } },
    { ...f.proof, originalResult: { ...f.result, sentFileId: undefined } }
  ]) {
    const outcome = await settleAgentSendDelivery(f.deliveryId, f.request, { ...f.options, verify: async () => proof });
    assert.equal(outcome.body.settlement, "not_attempted");
    assert.equal(outcome.body.state, "uncertain");
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
});
test("active is readable but cannot settle", async t => {
  const f = fixture(t); f.save({ ...f.receipt, ownerHost: os.hostname(), ownerPid: process.pid });
  assert.equal((await verifyAgentSendDelivery(f.deliveryId, f.request, f.options)).body.platformVerification, "present");
  const result = await settleAgentSendDelivery(f.deliveryId, f.request, { ...f.options, verify: async () => { assert.fail("must not verify active"); } });
  assert.equal(result.statusCode, 409); assert.equal(result.body.state, "in_progress");
});
test("completed settle replays unknown; verify independently checks current presence", async t => {
  const f = fixture(t); f.save({ ...f.receipt, state: "completed", result: f.result });
  const replay = await settleAgentSendDelivery(f.deliveryId, f.request, { ...f.options, verify: async () => { assert.fail("must not verify replay"); } });
  assert.equal(replay.body.platformVerification, "unknown"); assert.equal(replay.body.settlement, "not_attempted");
  assert.deepEqual(replay.body.originalResult, f.result);
  assert.equal((await verifyAgentSendDelivery(f.deliveryId, f.request, f.options)).body.platformVerification, "present");
});
test("missing corrupt digest conflict and ID mismatch", async t => {
  const f = fixture(t); const options = { ...f.options, verify: async () => { assert.fail("must not verify"); } };
  fs.unlinkSync(f.file); assert.equal((await verifyAgentSendDelivery(f.deliveryId, f.request, options)).statusCode, 404);
  fs.writeFileSync(f.file, "invalid-json"); assert.equal((await verifyAgentSendDelivery(f.deliveryId, f.request, options)).body.code, "RECEIPT_CORRUPT");
  f.save(); assert.equal((await settleAgentSendDelivery(f.deliveryId, { ...f.request, payload: { type: "file", path: "other.pdf" } }, options)).body.code, "DIGEST_CONFLICT");
  await assert.rejects(verifyAgentSendDelivery("other-id", f.request, options), /does not match/);
  await assert.rejects(verifyAgentSendDelivery("../unsafe", f.request, options), /Invalid deliveryId/);
});
test("unknown and unavailable verifier do not mutate", async t => {
  const f = fixture(t); const before = fs.readFileSync(f.file, "utf8");
  assert.equal((await settleAgentSendDelivery(f.deliveryId, f.request, { ...f.options, verify: async () => ({ platformVerification: "unknown", evidence: {} }) })).body.settlement, "not_attempted");
  for (const service of [verifyAgentSendDelivery, settleAgentSendDelivery]) assert.equal((await service(f.deliveryId, f.request,
    { ...f.options, verify: async () => { throw new Error("isolated unavailable"); } })).statusCode, 503);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});
test("concurrent settlements preserve terminal result", async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => settleAgentSendDelivery(f.deliveryId, f.request, f.options)));
  for (const result of results) { assert.equal(result.body.state, "completed"); assert.deepEqual(result.body.originalResult, f.result); assert.equal(result.body.deliveredNow, false); }
  assert.equal(results.filter(result => result.body.settlement === "committed").length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")).result, f.result);
});
test("persistence failure is 503 uncertain", async t => {
  const f = fixture(t); const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]) === f.file) throw new Error("isolated persistence failure"); return original(...args);
  });
  const result = await settleAgentSendDelivery(f.deliveryId, f.request, f.options);
  assert.equal(result.statusCode, 503); assert.equal(result.body.state, "uncertain");
  assert.equal(result.body.code, "RECEIPT_PERSIST_FAILED"); assert.equal(result.body.settlement, "failed");
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).state, "sending");
});
test("storage unavailable is distinguished from missing", async t => {
  const f = fixture(t);
  t.mock.method(fs, "statSync", () => { throw Object.assign(new Error("isolated access denied"), { code: "EACCES" }); });
  const result = await verifyAgentSendDelivery(f.deliveryId, f.request, f.options);
  assert.equal(result.statusCode, 503); assert.equal(result.body.code, "RECEIPT_UNAVAILABLE");
});
