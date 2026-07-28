import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES,
  PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES,
  PLAN_FEEDBACK_MAX_ATTACHMENTS,
  type PlanFeedbackAttachment,
  type PlanFeedbackAttachmentUpload
} from "./shared/planFeedbackContract.js";
import { normalizeStoredPlanAttachments } from "./planAttachments.js";
import { PLAN_MAX_ATTACHMENTS, type PlanAttachment } from "./shared/planAttachmentContract.js";

export type { PlanFeedbackAttachment } from "./shared/planFeedbackContract.js";

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
  attachments: PlanFeedbackAttachment[];
  planAttachments: PlanAttachment[];
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
  attachments?: PlanFeedbackAttachment[];
  planAttachments?: PlanAttachment[];
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

function safeFileName(value: unknown, fallback: string): string {
  const base = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_");
  return (base || fallback).slice(0, 180);
}

function normalizeMimeType(value: unknown): string | undefined {
  const mimeType = String(value || "").trim().toLowerCase();
  return mimeType ? mimeType.slice(0, 160) : undefined;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeBase64(value: unknown, name: string): Buffer {
  if (typeof value !== "string") throw new Error(`Approval attachment content is required: ${name}.`);
  const encoded = value.replace(/\s+/g, "");
  if (encoded && (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) {
    throw new Error(`Approval attachment is not valid base64: ${name}.`);
  }
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64").replace(/=+$/g, "") !== encoded.replace(/=+$/g, "")) {
    throw new Error(`Approval attachment is not valid base64: ${name}.`);
  }
  return content;
}

function normalizeStoredAttachments(value: unknown): PlanFeedbackAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Partial<PlanFeedbackAttachment>;
    const name = safeFileName(raw.name, "attachment");
    const filePath = String(raw.path || "").trim();
    const digest = String(raw.sha256 || "").trim().toLowerCase();
    const size = Number(raw.size);
    if (!filePath || !/^[a-f0-9]{64}$/.test(digest) || !Number.isFinite(size) || size < 0) return [];
    return [{
      kind: raw.kind === "image" ? "image" : "file",
      name,
      path: filePath,
      size,
      mimeType: normalizeMimeType(raw.mimeType),
      sha256: digest
    }];
  });
}

function attachmentSignature(attachments: PlanFeedbackAttachment[]): string {
  return JSON.stringify(attachments.map(({ kind, name, size, mimeType, sha256: digest }) => ({
    kind,
    name,
    size,
    mimeType: mimeType || "",
    sha256: digest
  })));
}

export function planFeedbackAttachmentsEqual(
  left: PlanFeedbackAttachment[] | undefined,
  right: PlanFeedbackAttachment[] | undefined
): boolean {
  return attachmentSignature(normalizeStoredAttachments(left)) === attachmentSignature(normalizeStoredAttachments(right));
}

function planAttachmentSignature(attachments: PlanAttachment[]): string {
  return JSON.stringify(attachments.map(({ id, kind, name, size, mimeType, sha256: digest }) => ({
    id,
    kind,
    name,
    size,
    mimeType: mimeType || "",
    sha256: digest
  })));
}

export function planFeedbackPlanAttachmentsEqual(
  left: PlanAttachment[] | undefined,
  right: PlanAttachment[] | undefined
): boolean {
  return planAttachmentSignature(normalizeStoredPlanAttachments(left))
    === planAttachmentSignature(normalizeStoredPlanAttachments(right));
}

export function resolvePlanFeedbackPlanAttachments(
  availableValue: unknown,
  requestedValue: unknown,
  existingValue?: unknown
): PlanAttachment[] {
  const existing = normalizeStoredPlanAttachments(existingValue);
  if (requestedValue === undefined) return existing;
  if (!Array.isArray(requestedValue)) throw new Error("Plan attachment mentions must be an array of attachment ids.");
  if (requestedValue.length > PLAN_MAX_ATTACHMENTS) {
    throw new Error(`Approval feedback can mention at most ${PLAN_MAX_ATTACHMENTS} plan attachments.`);
  }
  const requestedIds = requestedValue.map((value) => String(value || "").trim());
  if (requestedIds.some((id) => !id)) throw new Error("Plan attachment mention id is required.");
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new Error("Plan attachment mention ids must be unique.");
  }
  if (requestedIds.length === existing.length && requestedIds.every((id, index) => existing[index]?.id === id)) {
    return existing;
  }
  const available = normalizeStoredPlanAttachments(availableValue);
  const byId = new Map(available.map((attachment) => [attachment.id, attachment]));
  return requestedIds.map((id) => {
    const attachment = byId.get(id);
    if (!attachment) throw new Error(`Plan attachment not found: ${id}`);
    return attachment;
  });
}

export function storePlanFeedbackAttachments(
  roleDir: string,
  feedbackId: string,
  value: unknown,
  expected?: PlanFeedbackAttachment[]
): PlanFeedbackAttachment[] {
  if (!Array.isArray(value)) throw new Error("Approval feedback attachments must be an array.");
  if (value.length > PLAN_FEEDBACK_MAX_ATTACHMENTS) {
    throw new Error(`Approval feedback supports at most ${PLAN_FEEDBACK_MAX_ATTACHMENTS} attachments.`);
  }
  const attachmentDir = path.join(roleDir, "plans", "feedback", "attachments", safeIdPart(feedbackId) || "feedback");
  let total = 0;
  const prepared = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Approval attachment ${index + 1} is invalid.`);
    }
    const raw = item as Partial<PlanFeedbackAttachmentUpload>;
    const name = safeFileName(raw.name, `attachment-${index + 1}`);
    const content = decodeBase64(raw.contentBase64, name);
    total += content.byteLength;
    if (content.byteLength > PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Approval attachment exceeds ${PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES} bytes: ${name}.`);
    }
    if (total > PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES) {
      throw new Error(`Approval feedback attachments exceed ${PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES} bytes in total.`);
    }
    const mimeType = normalizeMimeType(raw.mimeType);
    const target = path.join(attachmentDir, `${String(index + 1).padStart(2, "0")}-${name}`);
    const metadata: PlanFeedbackAttachment = {
      kind: raw.kind === "image" || mimeType?.startsWith("image/") ? "image" : "file",
      name,
      path: target,
      size: content.byteLength,
      mimeType,
      sha256: sha256(content)
    };
    return { content, metadata };
  });
  const attachments = prepared.map((item) => item.metadata);
  if (expected && !planFeedbackAttachmentsEqual(expected, attachments)) {
    throw new Error(`Feedback id already exists with different attachments: ${feedbackId}`);
  }
  if (!prepared.length) return [];
  fs.mkdirSync(attachmentDir, { recursive: true });
  for (const item of prepared) {
    if (fs.existsSync(item.metadata.path)) {
      if (sha256(fs.readFileSync(item.metadata.path)) !== item.metadata.sha256) {
        throw new Error(`Approval attachment path already contains different content: ${item.metadata.name}.`);
      }
      continue;
    }
    fs.writeFileSync(item.metadata.path, item.content, { flag: "wx" });
  }
  return attachments;
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
    attachments: normalizeStoredAttachments(input.attachments),
    planAttachments: normalizeStoredPlanAttachments(input.planAttachments),
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
  deliveryStatus: "pending" | "delivered" | "failed",
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
      latestById.set(value.id, {
        ...value,
        attachments: normalizeStoredAttachments(value.attachments),
        planAttachments: normalizeStoredPlanAttachments(value.planAttachments)
      } as PlanFeedbackRecord);
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
