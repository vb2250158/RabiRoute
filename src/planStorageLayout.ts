import path from "node:path";
import {
  canonicalLogicalPlanId,
  canonicalPlanStorageCollisionKey,
  canonicalPlanStorageKey,
  safePlanStorageSegment
} from "./planStorageIdentity.js";

export { canonicalLogicalPlanId } from "./planStorageIdentity.js";

export type PlanStorageBucket = "active" | "archive";

export function isArchivedPlanStatus(archiveStatus: unknown): boolean {
  return archiveStatus === "已归档";
}

export function isCompletedPlanStatus(status: unknown): boolean {
  return status === "完成" || status === "已完成";
}

export function safePlanStorageId(value: unknown): string {
  return safePlanStorageSegment(value);
}

export function canonicalPlanStorageName(planId: unknown): string {
  return canonicalPlanStorageKey(canonicalLogicalPlanId(planId));
}

export function canonicalPlanStorageIdentity(planId: unknown): string {
  return canonicalPlanStorageName(planId);
}

export function canonicalPlanStorageCollisionIdentity(planId: unknown): string {
  return canonicalPlanStorageCollisionKey(canonicalLogicalPlanId(planId));
}

export function planBucketForArchiveStatus(archiveStatus: unknown): PlanStorageBucket {
  return isArchivedPlanStatus(archiveStatus) ? "archive" : "active";
}

export function planDirectory(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(roleDir, "plans", bucket, canonicalPlanStorageName(planId));
}

export function planStorageDirectory(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return planDirectory(roleDir, planId, bucket);
}

export function planJsonFile(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(planDirectory(roleDir, planId, bucket), "plan.json");
}

export function planHistoryFile(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(planDirectory(roleDir, planId, bucket), "history.jsonl");
}

export function planFeedbackFile(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(planDirectory(roleDir, planId, bucket), "feedback.jsonl");
}

export function planAttachmentDirectory(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(planDirectory(roleDir, planId, bucket), "attachments");
}

export function planFeedbackAttachmentDirectory(
  roleDir: string,
  planId: unknown,
  feedbackId: unknown,
  bucket: PlanStorageBucket
): string {
  return path.join(planDirectory(roleDir, planId, bucket), "feedback-attachments", safePlanStorageId(feedbackId) || "feedback");
}
