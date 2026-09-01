import path from "node:path";
import { canonicalPlanStorageName, safePlanStorageId } from "./planStorageLayout.js";

/**
 * Pre-canonical layout paths. Only startup migration and its fixtures may use
 * these helpers; READY/runtime code must remain canonical-only.
 */
export function legacyActivePlanFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "items", "active", `${canonicalPlanStorageName(planId)}.json`);
}

export function legacyArchivedPlanFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "archive", `${canonicalPlanStorageName(planId)}.json`);
}

export function legacyPlanHistoryFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "history", `${canonicalPlanStorageName(planId)}.jsonl`);
}

export function legacyPlanFeedbackFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "feedback", `${canonicalPlanStorageName(planId)}.jsonl`);
}

export function legacyPlanAttachmentDirectory(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "attachments", canonicalPlanStorageName(planId));
}

export function legacyPlanFeedbackAttachmentDirectory(roleDir: string, feedbackId: unknown): string {
  return path.join(roleDir, "plans", "feedback", "attachments", safePlanStorageId(feedbackId) || "feedback");
}
