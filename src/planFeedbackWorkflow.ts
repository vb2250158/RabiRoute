import { randomUUID } from "node:crypto";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { planActivationStatus, planMarkerStatus } from "./planState.js";
import { readCanonicalPlanJsonUnderLease, readCanonicalPlanStoragePackageUnderLease,
  type PlanStorageLease, type PlanStorageTransactionOperation } from "./planStorageRepository.js";
import { createStorageRevision } from "./shared/storageRevision.js";
import { planApprovalGate, type PlanItem } from "./roleKnowledge.js";
import type { PlanFeedbackRecord } from "./planFeedback.js";

/** The feedback store commits these operations together with its ledger row. */
export function feedbackPlanTransition(lease: PlanStorageLease, feedback: PlanFeedbackRecord,
  phase: "saved" | "delivered"): { record: PlanFeedbackRecord; operations: PlanStorageTransactionOperation[] } {
  const unchanged = { record: feedback, operations: [] };
  if (feedback.kind !== "approval_suggestion" || feedback.author === "agent") return unchanged;
  const before = readCanonicalPlanJsonUnderLease(lease) as unknown as PlanItem;
  const workflow = ensurePersonaPlanWorkflow(lease.roleDir).workflow;
  if (planActivationStatus(before, workflow) !== "进行中" || before.currentStepId !== feedback.stepId) return unchanged;
  const marker = planMarkerStatus(before);
  if (phase === "saved" && (marker !== workflow.roles.approval && marker !== workflow.roles.approved
    || planApprovalGate(before).state !== "pending")) return unchanged;
  if (phase === "delivered") {
    if (feedback.deliveryStatus !== "delivered" || !feedback.approvalTransition || marker !== workflow.roles.approved) return unchanged;
    const historyText = readCanonicalPlanStoragePackageUnderLease(lease).files.find(file => file.path === "history.jsonl")?.content.toString("utf8") || "";
    const history = historyText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { after: PlanItem });
    const index = history.findIndex(row => row.after.storageRevision === feedback.approvalTransition!.planRevision);
    if (index < 0) return unchanged;
    const signature = (plan: PlanItem) => JSON.stringify({ marker: planMarkerStatus(plan), activation: planActivationStatus(plan),
      currentStepId: plan.currentStepId, steps: plan.steps, title: plan.title, focus: plan.focus,
      nextAction: plan.nextAction, waitingFor: plan.waitingFor, attachments: plan.attachments, taskBinding: plan.taskBinding });
    const expected = signature(history[index]!.after);
    if (signature(before) !== expected || history.slice(index + 1).some(row => signature(row.after) !== expected)) return unchanged;
  }
  const status = phase === "saved" ? workflow.roles.approved : workflow.roles.analysis;
  const after: PlanItem = { ...before, status, markerStatus: status,
    updatedAt: new Date().toISOString(), storageRevision: createStorageRevision() };
  const record = phase === "saved" ? { ...feedback, approvalTransition: { planRevision: after.storageRevision! } } : feedback;
  const history = readCanonicalPlanStoragePackageUnderLease(lease).files.find(file => file.path === "history.jsonl")?.content.toString("utf8") || "";
  const row = { id: `history-${randomUUID()}`, planId: before.id, kind: "updated", recordedAt: after.updatedAt, before, after };
  return { record, operations: [
    { type: "replace-file", relativePath: "plan.json", content: Buffer.from(`${JSON.stringify(after, null, 2)}\n`) },
    { type: "replace-file", relativePath: "history.jsonl", content: Buffer.from(`${history}${history && !history.endsWith("\n") ? "\n" : ""}${JSON.stringify(row)}\n`) }
  ] };
}
