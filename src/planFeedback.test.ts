import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback,
  planFeedbackAttachmentsEqual,
  planFeedbackPlanAttachmentsEqual,
  planFeedbackSummary,
  resolvePlanFeedbackPlanAttachments,
  storePlanFeedbackAttachments,
  updatePlanFeedbackDelivery
} from "./planFeedback.js";

test("plan feedback records approval context and collapses delivery updates", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-feedback-"));
  const pending = createPlanFeedbackRecord({
    id: "request-1",
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Approval plan",
    stepId: "review",
    stepTitle: "等待审批",
    gatewayId: "route-1",
    source: "webgui",
    text: "建议补充回归范围后继续。",
    planAttachments: [{
      id: "preview",
      kind: "image",
      name: "preview.png",
      path: path.join(roleDir, "plans", "attachments", "plan-1", "preview.png"),
      size: 12,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }]
  });
  appendPlanFeedback(roleDir, pending);
  updatePlanFeedbackDelivery(roleDir, pending, "failed", "temporary delivery failure");
  updatePlanFeedbackDelivery(roleDir, pending, "pending");
  updatePlanFeedbackDelivery(roleDir, pending, "delivered");

  const records = listPlanFeedback(roleDir, "plan-1");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.deliveryStatus, "delivered");
  assert.equal(records[0]?.stepId, "review");
  assert.equal(records[0]?.planAttachments[0]?.id, "preview");
  assert.deepEqual(planFeedbackSummary(roleDir, "plan-1"), { count: 1, latest: records[0] });
});

test("agent feedback is record-only and text length is validated", () => {
  const record = createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Approval plan",
    author: "agent",
    source: "agent",
    kind: "approval_response",
    text: "已按建议补充验证范围。"
  });
  assert.equal(record.deliveryStatus, "record_only");
  assert.throws(() => createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Approval plan",
    text: "a".repeat(2_001)
  }), /exceeds 2000/);
});

test("plan feedback compares mentioned plan attachments by stable metadata", () => {
  const reference = [{
    id: "report",
    kind: "file" as const,
    name: "report.md",
    path: "C:/private/role/plans/attachments/plan/report.md",
    size: 9,
    mimeType: "text/markdown",
    sha256: "b".repeat(64)
  }];
  assert.equal(planFeedbackPlanAttachmentsEqual(reference, reference), true);
  assert.equal(planFeedbackPlanAttachmentsEqual(reference, [{ ...reference[0]!, sha256: "c".repeat(64) }]), false);
  assert.deepEqual(resolvePlanFeedbackPlanAttachments(reference, ["report"]), reference);
  assert.deepEqual(resolvePlanFeedbackPlanAttachments([], ["report"], reference), reference);
  assert.throws(() => resolvePlanFeedbackPlanAttachments(reference, ["missing"]), /not found/);
  assert.throws(() => resolvePlanFeedbackPlanAttachments(reference, ["report", "report"]), /unique/);
});

test("plan feedback attachments are private, bounded, and idempotent", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-feedback-files-"));
  const contentBase64 = Buffer.from("image bytes", "utf8").toString("base64");
  const first = storePlanFeedbackAttachments(roleDir, "request-with-file", [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64
  }]);
  const retry = storePlanFeedbackAttachments(roleDir, "request-with-file", [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64
  }], first);

  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "image");
  assert.equal(fs.readFileSync(first[0]!.path, "utf8"), "image bytes");
  assert.equal(planFeedbackAttachmentsEqual(first, retry), true);
  assert.throws(() => storePlanFeedbackAttachments(roleDir, "request-with-file", [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64: Buffer.from("different", "utf8").toString("base64")
  }], first), /different attachments/);
});
