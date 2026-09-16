import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, getPlan, updatePlan, type PlanApprovalRequest } from "./roleKnowledge.js";
import { submitPlanFeedback } from "./planFeedbackSubmission.js";
import { commitPlanFeedback, createPlanFeedbackRecord, listPlanFeedback, recoverPlanFeedbackStoreTransactions, updatePlanFeedbackDelivery } from "./planFeedback.js";
import { planPresentation } from "./roleKnowledgePresentation.js";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";

const contract: PlanApprovalRequest = { approver: "Owner", request: "Approve the scoped change", recommendation: "Use the minimal change", reason: "Confirm scope",
  files: [{ path: "src/example.ts", action: "modify", change: "Fix the scoped behavior" }], commands: [], changes: [],
  validation: ["Run tests"], rollback: ["Revert change"], outOfScope: ["No deployment"], requestedAt: "2026-01-01T00:00:00Z", sourceMessageId: "source", responseStatus: "pending" };
function fixture(t: test.TestContext) {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-workflow-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const plan = createPlan(roleDir, { title: "Approval test", focus: "Approval delivery", status: "待审批", keywords: ["approval"],
    currentStepId: "review", steps: [{ id: "review", title: "Review change", approvalRequest: contract }] });
  const submit = (id: string, extra = {}) => submitPlanFeedback({ roleDir, roleId: "test", planId: plan.id, feedbackId: id,
    stepId: "review", text: "Please apply the scoped decision", kind: "approval_suggestion", ...extra });
  return { roleDir, plan, submit, read: () => getPlan(roleDir, plan.id)! };
}
test("saved approval persists approved; failures wait; confirmed delivery returns analysis after secretary assignment", t => {
  const { roleDir, submit, read, plan } = fixture(t);
  const saved = submit("first", { notifyAgent: false });
  assert.equal(saved.plan.markerStatus, "已审批");
  assert.equal(read().markerStatus, "已审批");
  assert.equal(planPresentation(read(), ensurePersonaPlanWorkflow(roleDir).workflow).approval.state, "approved");
  assert.equal(submit("first", { notifyAgent: false }).created, false);
  updatePlanFeedbackDelivery(roleDir, saved.record, "failed");
  assert.equal(read().markerStatus, "已审批");
  updatePlanFeedbackDelivery(roleDir, saved.record, "pending");
  updatePlan(roleDir, plan.id, { secretaryBinding: { agentType: "dsh", sessionId: "secretary", workspace: os.tmpdir() } });
  updatePlanFeedbackDelivery(roleDir, saved.record, "delivered");
  assert.equal(read().markerStatus, "分析中");
  updatePlanFeedbackDelivery(roleDir, saved.record, "failed");
  assert.equal(listPlanFeedback(roleDir, plan.id)[0]!.deliveryStatus, "delivered");
  updatePlan(roleDir, plan.id, { nextAction: "Review the recorded decision" });
});
test("old feedback receipt cannot advance a newer approval or overwrite changed plan", t => {
  const { roleDir, submit, read, plan } = fixture(t);
  const old = submit("old");
  const latest = submit("latest");
  updatePlanFeedbackDelivery(roleDir, old.record, "delivered");
  assert.equal(read().markerStatus, "已审批");
  updatePlan(roleDir, plan.id, { nextAction: "Changed by current owner" });
  updatePlanFeedbackDelivery(roleDir, latest.record, "delivered");
  assert.equal(read().markerStatus, "已审批");
});
test("approval and feedback recover together after a mid-transaction crash", t => {
  const { roleDir, plan, read } = fixture(t);
  const record = createPlanFeedbackRecord({ id: "crash", roleId: "test", planId: plan.id, planTitle: plan.title,
    stepId: "review", text: "Scoped approval" });
  assert.throws(() => commitPlanFeedback(roleDir, record, undefined, { repositoryTransaction: { hooks: {
    afterOperation(index) { if (index === 0) throw new Error("injected interruption"); }
  } } }), /injected interruption/);
  assert.equal(recoverPlanFeedbackStoreTransactions(roleDir).failures.length, 0);
  assert.equal(read().markerStatus, "已审批");
  assert.equal(listPlanFeedback(roleDir, plan.id).length, 1);
  assert.equal(commitPlanFeedback(roleDir, record).created, false);
});
test("approved marker without a pending complete contract does not enable approval", t => {
  const { read, roleDir } = fixture(t);
  const plan = { ...read(), status: "已审批", markerStatus: "已审批", steps: [{ id: "review", title: "Review" }] };
  const presentation = planPresentation(plan, ensurePersonaPlanWorkflow(roleDir).workflow);
  assert.equal(presentation.approval.state, "approved");
  assert.equal(presentation.approval.enabled, false);
});
test("structured answers survive reload, reject changed contract, and safely reuse attachment bytes", t => {
  const { roleDir, submit, read, plan } = fixture(t);
  const formData = { questions: [], approvalContract: read().steps[0]!.approvalRequest, answers: { "approval-decision": { optionId: "execute" } }, text: "Scope retained" };
  const first = submit("form", { formData, attachments: [{ name: "evidence.txt", contentBase64: Buffer.from("evidence").toString("base64") }] });
  assert.match(first.record.text, /按此方案执行/);
  assert.deepEqual(listPlanFeedback(roleDir, plan.id)[0]!.formData, JSON.parse(JSON.stringify(formData)));
  const edit = submit("edited", { formData, reuseFeedbackId: "form" });
  assert.equal(fs.readFileSync(edit.record.attachments[0]!.path, "utf8"), "evidence");
  assert.throws(() => submit("bad", { formData: { ...formData, approvalContract: { ...formData.approvalContract, request: "Stale" } } }), /contract changed/);
  assert.throws(() => submit("edited", { formData: { ...formData, text: "different" } }), /different content/);
});
