import { randomUUID } from "node:crypto";
import { isPlanHistoryPath, orderedPlanHistoryPaths, planHistoryFileDigest, preparePlanHistoryAppend, setPlanHistoryCommitmentFromDigests } from "./planHistoryShards.js";
import { normalizePlanHistoryActor, type PlanHistoryActor } from "./shared/planHistoryActor.js";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { planActivationStatus, planMarkerStatus } from "./planState.js";
import { readCanonicalPlanJsonUnderLease, readCanonicalPlanStoragePackageUnderLease,
  type PlanStorageLease, type PlanStorageTransactionOperation } from "./planStorageRepository.js";
import { createStorageRevision } from "./shared/storageRevision.js";
import { planApprovalGate, type PlanItem } from "./roleKnowledge.js";
import type { PlanFeedbackRecord } from "./planFeedback.js";

/** The feedback store commits these operations together with its ledger row. */
export function feedbackPlanTransition(lease: PlanStorageLease, feedback: PlanFeedbackRecord,
  phase: "saved" | "delivered", actor?: PlanHistoryActor): { record: PlanFeedbackRecord; operations: PlanStorageTransactionOperation[] } {
  const unchanged = { record: feedback, operations: [] };
  if (feedback.kind !== "approval_suggestion" || feedback.author === "agent") return unchanged;
  const { historyCommitment: _historyCommitment, ...beforeRaw } = readCanonicalPlanJsonUnderLease(lease);
  const before = beforeRaw as unknown as PlanItem;
  const workflow = ensurePersonaPlanWorkflow(lease.roleDir).workflow;
  if (planActivationStatus(before, workflow) !== "进行中" || before.currentStepId !== feedback.stepId) return unchanged;
  const marker = planMarkerStatus(before);
  if (phase === "saved" && (marker !== workflow.roles.approval && marker !== workflow.roles.approved
    || planApprovalGate(before).state !== "pending")) return unchanged;
  const historyFiles = new Map(readCanonicalPlanStoragePackageUnderLease(lease).files
    .filter(file => isPlanHistoryPath(file.path)).map(file => [file.path, file]));
  if (phase === "delivered") {
    if (feedback.deliveryStatus !== "delivered" || !feedback.approvalTransition || marker !== workflow.roles.approved) return unchanged;
    const signature = (plan: PlanItem) => JSON.stringify({ marker: planMarkerStatus(plan), activation: planActivationStatus(plan),
      currentStepId: plan.currentStepId, steps: plan.steps, title: plan.title, focus: plan.focus,
      nextAction: plan.nextAction, waitingFor: plan.waitingFor, attachments: plan.attachments, taskBinding: plan.taskBinding });
    let expected: string | undefined;
    for (const file of orderedPlanHistoryPaths(historyFiles.keys())) {
      for (const line of historyFiles.get(file)!.content.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        const { after } = JSON.parse(line) as { after: PlanItem };
        if (expected !== undefined) {
          if (signature(after) !== expected) return unchanged;
        } else if (after.storageRevision === feedback.approvalTransition.planRevision) {
          expected = signature(after);
        }
      }
    }
    if (expected === undefined || signature(before) !== expected) return unchanged;
  }
  const status = phase === "saved" ? workflow.roles.approved : workflow.roles.analysis;
  const after: PlanItem = { ...before, status, markerStatus: status,
    updatedAt: new Date().toISOString(), storageRevision: createStorageRevision() };
  const record = phase === "saved" ? { ...feedback, approvalTransition: { planRevision: after.storageRevision! } } : feedback;
  const historyActor = phase === "delivered"
    ? { kind: "system" as const, displayName: "计划反馈投递", channel: "manager" }
    : normalizePlanHistoryActor(actor) ?? { kind: "unknown" as const };
  const row = { actor: historyActor, id: `history-${randomUUID()}`,  planId: before.id, kind: "updated", recordedAt: after.updatedAt, before, after };
  const changed = preparePlanHistoryAppend([...historyFiles.values()], row);
  historyFiles.delete(changed.path);
  const digests = [...historyFiles.values()].map(file => ({ path: file.path, bytes: file.size, sha256: file.sha256 }));
  digests.push(planHistoryFileDigest(changed.path, changed.content));
  const committed = setPlanHistoryCommitmentFromDigests(after as unknown as Record<string, unknown>, digests);
  return { record, operations: [
    { type: "replace-file", relativePath: "plan.json", content: Buffer.from(`${JSON.stringify(committed, null, 2)}\n`) },
    { type: "replace-file", relativePath: changed.path, content: changed.content }
  ] };
}
