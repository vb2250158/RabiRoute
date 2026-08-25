import path from "node:path";

export type PlanStorageBucket = "active" | "archive";

export function safePlanStorageId(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function planStorageName(planId: unknown): string {
  return safePlanStorageId(planId) || "plan";
}

export function planBucketForStatus(status: unknown): PlanStorageBucket {
  return status === "已归档" ? "archive" : "active";
}

export function planDirectory(roleDir: string, planId: unknown, bucket: PlanStorageBucket): string {
  return path.join(roleDir, "plans", bucket, planStorageName(planId));
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

export function legacyActivePlanFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "items", "active", `${planStorageName(planId)}.json`);
}

export function legacyArchivedPlanFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "archive", `${planStorageName(planId)}.json`);
}

export function legacyPlanHistoryFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "history", `${planStorageName(planId)}.jsonl`);
}

export function legacyPlanFeedbackFile(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "feedback", `${planStorageName(planId)}.jsonl`);
}

export function legacyPlanAttachmentDirectory(roleDir: string, planId: unknown): string {
  return path.join(roleDir, "plans", "attachments", planStorageName(planId));
}

export function legacyPlanFeedbackAttachmentDirectory(roleDir: string, feedbackId: unknown): string {
  return path.join(roleDir, "plans", "feedback", "attachments", safePlanStorageId(feedbackId) || "feedback");
}
