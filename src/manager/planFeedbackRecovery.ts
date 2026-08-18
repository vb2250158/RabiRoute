import fs from "node:fs";
import path from "node:path";
import {
  listPlanFeedback,
  planFeedbackResponseId,
  updatePlanFeedbackDelivery,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import { listPlans, type PlanItem } from "../roleKnowledge.js";

export type PlanFeedbackRecoveryCandidate = {
  roleDir: string;
  roleId: string;
  plan: PlanItem;
  feedback: PlanFeedbackRecord;
};

export type PlanFeedbackDeliveryInspection = "accepted" | "in_progress" | "missing";

export type PlanFeedbackRecoveryTaskRequest = {
  threadId: string;
  cwd: string;
  deliveryId: string;
};

export type PlanFeedbackRecoveryOutcome =
  | { state: "delivered"; record: PlanFeedbackRecord }
  | { state: "scheduled" }
  | { state: "deferred"; reason: string };

function isRecoverableFeedback(record: PlanFeedbackRecord): boolean {
  return (record.deliveryStatus === "pending" || record.deliveryStatus === "failed")
    && (record.kind === "guidance" || record.kind === "approval_suggestion")
    && record.author !== "agent"
    && !record.qaHandling;
}

export function listOpenPlanFeedbackRecoveryCandidates(
  rolesRoot: string
): PlanFeedbackRecoveryCandidate[] {
  if (!fs.existsSync(rolesRoot)) return [];
  const candidates: PlanFeedbackRecoveryCandidate[] = [];
  for (const entry of fs.readdirSync(rolesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roleId = entry.name;
    const roleDir = path.join(rolesRoot, roleId);
    for (const plan of listPlans(roleDir)) {
      for (const feedback of listPlanFeedback(roleDir, plan.id)) {
        if (isRecoverableFeedback(feedback)) {
          candidates.push({ roleDir, roleId, plan, feedback });
        }
      }
    }
  }
  return candidates.sort((left, right) => {
    const createdDelta = Date.parse(left.feedback.createdAt) - Date.parse(right.feedback.createdAt);
    return createdDelta || left.feedback.id.localeCompare(right.feedback.id);
  });
}

export async function recoverPlanFeedbackCandidate(
  candidate: PlanFeedbackRecoveryCandidate,
  options: {
    inspect: (request: PlanFeedbackRecoveryTaskRequest) => Promise<PlanFeedbackDeliveryInspection>;
    schedule: (candidate: PlanFeedbackRecoveryCandidate) => Promise<void>;
  }
): Promise<PlanFeedbackRecoveryOutcome> {
  const responseKind = candidate.feedback.kind === "guidance"
    ? "guidance_response"
    : "approval_response";
  const linkedResponse = listPlanFeedback(candidate.roleDir, candidate.plan.id).find((record) => (
    record.id === planFeedbackResponseId(candidate.feedback)
    && record.kind === responseKind
    && record.author === "agent"
  ));
  if (linkedResponse) {
    return {
      state: "delivered",
      record: updatePlanFeedbackDelivery(
        candidate.roleDir,
        candidate.feedback,
        "delivered",
        `Manager recovery confirmed linked ${responseKind} ${linkedResponse.id}.`
      )
    };
  }

  const binding = candidate.plan.taskBinding;
  if (!binding?.sessionId?.trim() || !binding.workspace?.trim()) {
    await options.schedule(candidate);
    return { state: "scheduled" };
  }

  let state: PlanFeedbackDeliveryInspection;
  try {
    state = await options.inspect({
      threadId: binding.sessionId.trim(),
      cwd: binding.workspace.trim(),
      deliveryId: candidate.feedback.id
    });
  } catch (error) {
    return {
      state: "deferred",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (state === "accepted") {
    return {
      state: "delivered",
      record: updatePlanFeedbackDelivery(
        candidate.roleDir,
        candidate.feedback,
        "delivered",
        "Manager recovery confirmed the feedback in the bound Desktop task."
      )
    };
  }
  if (state === "in_progress") {
    return {
      state: "deferred",
      reason: "The bound Desktop task is active; wait for an authoritative delivery readback."
    };
  }

  await options.schedule(candidate);
  return { state: "scheduled" };
}
