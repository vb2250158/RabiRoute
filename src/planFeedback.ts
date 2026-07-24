import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type PlanFeedbackKind = "approval_suggestion" | "approval_response";
export type PlanFeedbackAuthor = "user" | "agent" | "system";
export type PlanFeedbackSource = "webgui" | "tray" | "qq" | "agent" | "api";
export type PlanFeedbackDeliveryStatus = "record_only" | "pending" | "delivered" | "failed";

export type PlanFeedbackRecord = {
  id: string;
  roleId: string;
  planId: string;
  planTitle: string;
  stepId?: string;
  stepTitle?: string;
  gatewayId?: string;
  kind: PlanFeedbackKind;
  author: PlanFeedbackAuthor;
  source: PlanFeedbackSource;
  text: string;
  createdAt: string;
  updatedAt: string;
  deliveryStatus: PlanFeedbackDeliveryStatus;
  deliveryMessage?: string;
};

export type CreatePlanFeedbackInput = {
  id?: unknown;
  roleId: string;
  planId: string;
  planTitle: string;
  stepId?: unknown;
  stepTitle?: unknown;
  gatewayId?: unknown;
  kind?: unknown;
  author?: unknown;
  source?: unknown;
  text?: unknown;
  notifyAgent?: unknown;
};

const MAX_FEEDBACK_CHARS = 2_000;

function safeIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100);
}

function optionalText(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function feedbackFile(roleDir: string, planId: string): string {
  return path.join(roleDir, "plans", "feedback", `${safeIdPart(planId) || "plan"}.jsonl`);
}

function normalizeKind(value: unknown): PlanFeedbackKind {
  return value === "approval_response" ? "approval_response" : "approval_suggestion";
}

function normalizeAuthor(value: unknown): PlanFeedbackAuthor {
  return value === "agent" || value === "system" ? value : "user";
}

function normalizeSource(value: unknown, author: PlanFeedbackAuthor): PlanFeedbackSource {
  if (value === "webgui" || value === "tray" || value === "qq" || value === "agent") return value;
  return author === "agent" ? "agent" : "api";
}

export function createPlanFeedbackRecord(input: CreatePlanFeedbackInput): PlanFeedbackRecord {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("Approval feedback text is required.");
  if (Array.from(text).length > MAX_FEEDBACK_CHARS) {
    throw new Error(`Approval feedback exceeds ${MAX_FEEDBACK_CHARS} characters.`);
  }
  const author = normalizeAuthor(input.author);
  const notifyAgent = input.notifyAgent !== false && author !== "agent";
  const createdAt = new Date().toISOString();
  return {
    id: safeIdPart(String(input.id || "")) || `feedback-${randomUUID()}`,
    roleId: input.roleId,
    planId: input.planId,
    planTitle: input.planTitle,
    stepId: optionalText(input.stepId),
    stepTitle: optionalText(input.stepTitle),
    gatewayId: optionalText(input.gatewayId),
    kind: normalizeKind(input.kind),
    author,
    source: normalizeSource(input.source, author),
    text,
    createdAt,
    updatedAt: createdAt,
    deliveryStatus: notifyAgent ? "pending" : "record_only"
  };
}

export function appendPlanFeedback(roleDir: string, record: PlanFeedbackRecord): PlanFeedbackRecord {
  const filePath = feedbackFile(roleDir, record.planId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function updatePlanFeedbackDelivery(
  roleDir: string,
  record: PlanFeedbackRecord,
  deliveryStatus: "delivered" | "failed",
  deliveryMessage?: string
): PlanFeedbackRecord {
  return appendPlanFeedback(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    deliveryStatus,
    deliveryMessage: optionalText(deliveryMessage)
  });
}

export function listPlanFeedback(roleDir: string, planId: string): PlanFeedbackRecord[] {
  const filePath = feedbackFile(roleDir, planId);
  if (!fs.existsSync(filePath)) return [];
  const latestById = new Map<string, PlanFeedbackRecord>();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line) as Partial<PlanFeedbackRecord>;
      if (!value.id || value.planId !== planId || !value.text || !value.createdAt) continue;
      latestById.set(value.id, value as PlanFeedbackRecord);
    } catch {
      // Keep other valid audit rows readable when one line is damaged.
    }
  }
  return [...latestById.values()].sort((left, right) => {
    const dateDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}

export function planFeedbackSummary(roleDir: string, planId: string): { count: number; latest?: PlanFeedbackRecord } {
  const records = listPlanFeedback(roleDir, planId);
  return { count: records.length, latest: records[0] };
}
