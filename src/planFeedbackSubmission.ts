import { resolvePlanAttachmentFile } from "./planAttachments.js";
import {
  createPlanFeedbackRecord,
  resolvePlanFeedbackPlanAttachments,
  type PlanFeedbackKind,
  type PlanFeedbackRecord
} from "./planFeedback.js";
import {
  commitPlanFeedbackUnderLease,
  listPlanFeedbackUnderLease
} from "./planFeedbackStore.js";
import {
  readCanonicalPlanJsonUnderLease,
  readCanonicalPlanStoragePackageUnderLease,
  withPlanStorageLease
} from "./planStorageRepository.js";
import { storageInventoryRevisionToken } from "./shared/storageRevision.js";
import {
  planAcceptsGuidance,
  type PlanItem
} from "./roleKnowledge.js";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";

export type SubmitPlanFeedbackInput = {
  roleDir: string;
  roleId: string;
  planId: string;
  feedbackId?: unknown;
  stepId?: unknown;
  gatewayId?: unknown;
  kind?: unknown;
  author?: unknown;
  source?: unknown;
  text?: unknown;
  notifyAgent?: unknown;
  planAttachmentIds?: unknown;
  attachments?: unknown;
  expectedRevision?: string;
  storageRevision?: string;
  storageMutationRequestId?: string;
};

export type SubmitPlanFeedbackResult = {
  record: PlanFeedbackRecord;
  created: boolean;
  plan: PlanItem;
};

/**
 * Application boundary for a feedback submission. The plan snapshot used for
 * every business decision is re-read after acquiring the same lease that
 * commits attachment bytes and the feedback ledger row.
 */
export function submitPlanFeedback(input: SubmitPlanFeedbackInput): SubmitPlanFeedbackResult {
  return withPlanStorageLease(input.roleDir, input.planId, (lease) => {
    if (input.expectedRevision !== undefined) {
      const currentRevision = storageInventoryRevisionToken(
        readCanonicalPlanStoragePackageUnderLease(lease).inventoryHash
      );
      if (input.expectedRevision !== currentRevision) {
        throw new Error(`STORAGE_MUTATION_REVISION_CONFLICT: expected=${input.expectedRevision}; current=${currentRevision}.`);
      }
    }
    const plan = readCanonicalPlanJsonUnderLease(lease) as unknown as PlanItem;
    const feedbackKind = String(input.kind || "approval_suggestion") as PlanFeedbackKind;
    const planLevelFeedback = feedbackKind === "guidance" || feedbackKind === "guidance_response";
    if (feedbackKind === "guidance" && !planAcceptsGuidance(plan, ensurePersonaPlanWorkflow(input.roleDir).workflow)) {
      throw new Error("Plan guidance is available only for configured guidance-enabled statuses outside approval.");
    }
    const requestedStepId = String(input.stepId || "").trim();
    if (planLevelFeedback && requestedStepId) {
      throw new Error("Plan guidance belongs to the plan and must not include a stepId.");
    }
    const step = planLevelFeedback
      ? undefined
      : requestedStepId
        ? plan.steps.find((item) => item.id === requestedStepId)
        : plan.steps.find((item) => item.id === plan.currentStepId);
    if (requestedStepId && !step) throw new Error(`Plan step not found: ${requestedStepId}`);

    const baseCandidate = createPlanFeedbackRecord({
      id: input.feedbackId,
      roleId: input.roleId,
      planId: input.planId,
      planTitle: plan.title,
      stepId: step?.id,
      stepTitle: step?.title,
      gatewayId: input.gatewayId,
      kind: input.kind,
      author: input.author,
      source: input.source,
      text: input.text,
      notifyAgent: input.notifyAgent
    });
    const existing = listPlanFeedbackUnderLease(lease).find((item) => item.id === baseCandidate.id);
    if (existing && (existing.text !== baseCandidate.text || existing.stepId !== baseCandidate.stepId)) {
      throw new Error(`Feedback id already exists with different content: ${baseCandidate.id}`);
    }
    const planAttachments = resolvePlanFeedbackPlanAttachments(
      plan.attachments,
      input.planAttachmentIds,
      existing?.planAttachments
    ).map((attachment) => ({
      ...attachment,
      path: resolvePlanAttachmentFile(input.roleDir, plan.id, attachment)
    }));
    const candidate = {
      ...baseCandidate,
      storageRevision: input.storageRevision ?? baseCandidate.storageRevision,
      storageMutationRequestId: input.storageMutationRequestId,
      attachments: existing?.attachments || [],
      planAttachments
    };
    const committed = commitPlanFeedbackUnderLease(lease, candidate, input.attachments);
    return { ...committed, plan };
  });
}
