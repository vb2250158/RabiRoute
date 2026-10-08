import assert from "node:assert/strict";
import test from "node:test";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import { durableDeliveryRequestDigest, type DurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import { createAgentSendVerificationEvidenceVerifier, type AgentSendHistoryEvidence, type AgentSendOriginalBindingEvidence } from "./agentSendVerificationEvidence.js";

function fixture(caption = false) {
  const request: AgentSendRequest = { deliveryId: "example-delivery", sender: { agentType: "message_processing", sessionId: "example-session" },
    routeId: "example-route", channel: "napcat", params: { target: "group", groupId: "100001", instanceId: "example-instance", replyToMessageId: "example-source" },
    payload: { type: "file", path: "example.pdf", ...(caption ? { text: "example caption" } : {}) } };
  const prepared = prepareAgentSendRequest(request);
  const { deliveryId: _id, ...payload } = request;
  const requestDigest = durableDeliveryRequestDigest(payload);
  const result: AgentSendResult = { ok: true, status: "sent", deliveryId: "example-delivery", sender: prepared.sender, channel: prepared.channel,
    routeId: prepared.routeId, target: prepared.target, instanceId: "example-instance", sentFileId: "example-file", ...(caption ? { sentMessageId: "example-caption" } : {}) };
  const history: AgentSendHistoryEvidence = { deliveryId: "example-delivery", requestDigest, historyConflict: false, terminalComplete: true, inspection: { state: "completed", result } };
  const binding: AgentSendOriginalBindingEvidence = { deliveryId: "example-delivery", requestDigest, binding: { routeId: "example-route", instanceId: "example-instance", groupId: "100001",
    platformFileId: "example-file", selfId: "100002", bindingRevision: "example-revision" } };
  const receipt: DurableDeliveryReceipt<AgentSendResult> = { version: 1, deliveryId: "example-delivery", requestDigest, state: "uncertain", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" };
  let platformReads = 0;
  const dependencies = { inspect: async () => history, getOriginalBinding: async () => binding, verifyCurrentPresence: async () => {
    platformReads++; return { status: "present" as const, reason: "exact_file_id" as const, deliveredNow: false as const, retryAllowed: false as const, sha256Verified: false as const, captionVerified: false as const };
  } };
  return { request, receipt, history, binding, result, dependencies, reads: () => platformReads };
}

for (const caption of [false, true]) test(`full original history plus current presence: caption=${caption}`, async () => {
  const f = fixture(caption); const before = JSON.stringify(f);
  const outcome = await createAgentSendVerificationEvidenceVerifier(f.dependencies)(f.request, f.receipt);
  assert.equal(outcome.platformVerification, "present"); assert.equal(outcome.originalTerminalProven, true);
  assert.deepEqual(outcome.originalResult, f.result); assert.equal(f.reads(), 1);
  assert.equal(JSON.stringify(f), before); assert.equal((outcome.evidence as { sha256Verified: boolean }).sha256Verified, false);
});
test("legacy missing original account evidence never invokes current verifier", async () => {
  const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier({ inspect: f.dependencies.inspect, verifyCurrentPresence: f.dependencies.verifyCurrentPresence })(f.request, f.receipt);
  assert.equal(outcome.platformVerification, "unknown"); assert.equal(outcome.originalTerminalProven, undefined); assert.equal(f.reads(), 0);
});
test("receipt ID/digest and history conflict fail closed before platform read", async () => {
  for (const change of [{ deliveryId: "other" }, { requestDigest: "other" }]) {
    const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier(f.dependencies)(f.request, { ...f.receipt, ...change });
    assert.equal(outcome.platformVerification, "unknown"); assert.equal(f.reads(), 0);
  }
  for (const change of [{ historyConflict: true }, { historyConflict: undefined }, { deliveryId: "other" }, { requestDigest: "other" }]) {
    const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, inspect: async () => ({ ...f.history, ...change } as AgentSendHistoryEvidence) })(f.request, f.receipt);
    assert.equal(outcome.platformVerification, "unknown"); assert.equal(f.reads(), 0);
  }
});
test("file presence cannot manufacture caption or full terminal proof", async () => {
  for (const complete of [false, true]) {
    const f = fixture(true); delete f.result.sentMessageId;
    const outcome = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, inspect: async () => ({ ...f.history, terminalComplete: complete ? true : undefined }) })(f.request, f.receipt);
    assert.equal(outcome.platformVerification, "present"); assert.equal(outcome.originalTerminalProven, undefined); assert.equal(outcome.originalResult, undefined);
  }
  const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, inspect: async () => ({ ...f.history, terminalComplete: undefined }) })(f.request, f.receipt);
  assert.equal(outcome.platformVerification, "present"); assert.equal(outcome.originalTerminalProven, undefined);
});
test("original binding fences cannot be filled from another delivery/file/account", async () => {
  for (const change of [{ selfId: "" }, { bindingRevision: "" }, { platformFileId: "other" }, { instanceId: "other" }, { groupId: "100003" }, { routeId: "other" }]) {
    const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, getOriginalBinding: async () => ({ ...f.binding, binding: { ...f.binding.binding, ...change } }) })(f.request, f.receipt);
    assert.equal(outcome.platformVerification, "unknown"); assert.equal(f.reads(), 0);
  }
  const f = fixture(); const outcome = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, getOriginalBinding: async () => ({ ...f.binding, requestDigest: "other" }) })(f.request, f.receipt);
  assert.equal(outcome.platformVerification, "unknown"); assert.equal(f.reads(), 0);
});
test("historical terminal and current existence are independent; sanitized failures", async () => {
  const f = fixture();
  const absent = await createAgentSendVerificationEvidenceVerifier({ ...f.dependencies, verifyCurrentPresence: async () => ({ status: "unknown", reason: "not_observed", deliveredNow: false, retryAllowed: false, sha256Verified: false, captionVerified: false }) })(f.request, f.receipt);
  assert.equal(absent.platformVerification, "unknown"); assert.equal(absent.originalTerminalProven, undefined);
  assert.equal((absent.evidence as { historicalTerminalProven: boolean }).historicalTerminalProven, true);
  const failed = await createAgentSendVerificationEvidenceVerifier({ inspect: async () => { throw new Error("example-private-diagnostic"); } })(f.request, f.receipt);
  assert.equal(failed.platformVerification, "unknown"); assert.ok(!JSON.stringify(failed).includes("example-private-diagnostic"));
});
test("factory captures read-only capabilities and rejects spoofed platform SHA proof", async () => {
  const f = fixture(); const verify = createAgentSendVerificationEvidenceVerifier(f.dependencies);
  f.dependencies.inspect = async () => { throw new Error("replacement must not execute"); };
  assert.equal((await verify(f.request, f.receipt)).platformVerification, "present");
  const spoofed = await createAgentSendVerificationEvidenceVerifier({ inspect: async () => f.history, getOriginalBinding: async () => f.binding,
    verifyCurrentPresence: async () => ({ status: "present", reason: "exact_file_id", deliveredNow: false, retryAllowed: false, sha256Verified: true, captionVerified: false } as unknown as Awaited<ReturnType<typeof f.dependencies.verifyCurrentPresence>>) })(f.request, f.receipt);
  assert.equal(spoofed.platformVerification, "unknown"); assert.equal(spoofed.originalTerminalProven, undefined);
});
test("conflicting saved result and malformed original request cannot pass", async () => {
  const f = fixture(); const verify = createAgentSendVerificationEvidenceVerifier(f.dependencies);
  assert.equal((await verify(f.request, { ...f.receipt, result: { ...f.result, sentFileId: "other" } })).platformVerification, "unknown");
  assert.equal((await verify({ ...f.request, deliveryId: "../invalid" }, f.receipt)).platformVerification, "unknown"); assert.equal(f.reads(), 0);
});
