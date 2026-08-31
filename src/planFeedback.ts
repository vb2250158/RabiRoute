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
import {
  legacyPlanFeedbackFile,
  planBucketForStatus,
  planFeedbackAttachmentDirectory,
  planFeedbackFile as planStorageFeedbackFile,
  planJsonFile,
  type PlanStorageBucket
} from "./planStorageLayout.js";

export type { PlanFeedbackAttachment } from "./shared/planFeedbackContract.js";

export type PlanFeedbackKind = "guidance" | "guidance_response" | "approval_suggestion" | "approval_response";
export type PlanFeedbackAuthor = "user" | "agent" | "system";
export type PlanFeedbackSource = "webgui" | "tray" | "qq" | "agent" | "api";
export type PlanFeedbackDeliveryStatus = "record_only" | "pending" | "delivered" | "failed";

export type PlanQaFeedbackHandling = {
  outcome: "failed" | "passed";
  issueType: "generic" | "account" | "version" | "timing" | "visual" | "crash";
  status: "waiting_for_evidence" | "dispatching" | "dispatched" | "completed" | "dispatch_failed";
  missingEvidence: string[];
  consumedAt: string;
  message?: string;
};

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
  qaHandling?: PlanQaFeedbackHandling;
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

export function planFeedbackResponseId(feedback: Pick<PlanFeedbackRecord, "id"> | string): string {
  const feedbackId = typeof feedback === "string" ? feedback : feedback.id;
  return `response-${feedbackId}`;
}

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
  if (typeof value !== "string") throw new Error(`Plan feedback attachment content is required: ${name}.`);
  const encoded = value.replace(/\s+/g, "");
  if (encoded && (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) {
    throw new Error(`Plan feedback attachment is not valid base64: ${name}.`);
  }
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64").replace(/=+$/g, "") !== encoded.replace(/=+$/g, "")) {
    throw new Error(`Plan feedback attachment is not valid base64: ${name}.`);
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
  planId: string,
  feedbackId: string,
  value: unknown,
  expected?: PlanFeedbackAttachment[]
): PlanFeedbackAttachment[] {
  if (!Array.isArray(value)) throw new Error("Approval feedback attachments must be an array.");
  if (value.length > PLAN_FEEDBACK_MAX_ATTACHMENTS) {
    throw new Error(`Approval feedback supports at most ${PLAN_FEEDBACK_MAX_ATTACHMENTS} attachments.`);
  }
  const attachmentDir = planFeedbackAttachmentDirectory(roleDir, planId, feedbackId, planStorageBucket(roleDir, planId));
  let total = 0;
  const prepared = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Plan feedback attachment ${index + 1} is invalid.`);
    }
    const raw = item as Partial<PlanFeedbackAttachmentUpload>;
    const name = safeFileName(raw.name, `attachment-${index + 1}`);
    const content = decodeBase64(raw.contentBase64, name);
    total += content.byteLength;
    if (content.byteLength > PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Plan feedback attachment exceeds ${PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES} bytes: ${name}.`);
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
        throw new Error(`Plan feedback attachment path already contains different content: ${item.metadata.name}.`);
      }
      continue;
    }
    fs.writeFileSync(item.metadata.path, item.content, { flag: "wx" });
  }
  return attachments;
}

function planStorageBucket(roleDir: string, planId: string): PlanStorageBucket {
  if (fs.existsSync(planJsonFile(roleDir, planId, "archive"))) return "archive";
  if (fs.existsSync(planJsonFile(roleDir, planId, "active"))) return "active";
  const legacy = path.join(roleDir, "plans", "archive", `${safeIdPart(planId) || "plan"}.json`);
  if (fs.existsSync(legacy)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, "utf8")) as { status?: unknown };
      return planBucketForStatus(raw.status);
    } catch {
      return "archive";
    }
  }
  return "active";
}

function feedbackFiles(roleDir: string, planId: string): string[] {
  return [
    planStorageFeedbackFile(roleDir, planId, "active"),
    planStorageFeedbackFile(roleDir, planId, "archive"),
    legacyPlanFeedbackFile(roleDir, planId)
  ];
}

function feedbackFile(roleDir: string, planId: string): string {
  return feedbackFiles(roleDir, planId).find((filePath) => fs.existsSync(filePath))
    || planStorageFeedbackFile(roleDir, planId, planStorageBucket(roleDir, planId));
}

function normalizeKind(value: unknown): PlanFeedbackKind {
  if (value === "guidance" || value === "guidance_response" || value === "approval_response") return value;
  return "approval_suggestion";
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
  if (!text) throw new Error("Plan feedback text is required.");
  if (Array.from(text).length > MAX_FEEDBACK_CHARS) {
    throw new Error(`Plan feedback exceeds ${MAX_FEEDBACK_CHARS} characters.`);
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

const asyncFeedbackWrites = new Map<string, Promise<void>>();

function awaitAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function appendPlanFeedbackAsync(
  roleDir: string,
  record: PlanFeedbackRecord,
  signal?: AbortSignal
): Promise<PlanFeedbackRecord> {
  signal?.throwIfAborted();
  const filePath = feedbackFile(roleDir, record.planId);
  const previous = asyncFeedbackWrites.get(filePath) ?? Promise.resolve();
  const write = previous.then(async () => {
    signal?.throwIfAborted();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    signal?.throwIfAborted();
    await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  });
  const tail = write.catch(() => {});
  asyncFeedbackWrites.set(filePath, tail);
  void tail.then(() => {
    if (asyncFeedbackWrites.get(filePath) === tail) asyncFeedbackWrites.delete(filePath);
  });
  await awaitAbortable(write, signal);
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

export function updatePlanFeedbackQaHandling(
  roleDir: string,
  record: PlanFeedbackRecord,
  qaHandling: PlanQaFeedbackHandling
): PlanFeedbackRecord {
  return appendPlanFeedback(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    deliveryStatus: qaHandling.status === "dispatch_failed"
      ? "failed"
      : qaHandling.status === "dispatching"
        ? "pending"
        : "delivered",
    qaHandling
  });
}

export function listPlanFeedback(roleDir: string, planId: string): PlanFeedbackRecord[] {
  return parsePlanFeedbackFiles(
    feedbackFiles(roleDir, planId).flatMap((filePath) => {
      if (!fs.existsSync(filePath)) return [];
      return [fs.readFileSync(filePath, "utf8")];
    }),
    planId
  );
}

function parsePlanFeedbackFiles(
  contents: readonly string[],
  expectedPlanId?: string
): PlanFeedbackRecord[] {
  const latestById = new Map<string, PlanFeedbackRecord>();
  for (const content of contents) {
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line) as Partial<PlanFeedbackRecord>;
      if (!value.id || !value.planId || !value.text || !value.createdAt) continue;
      if (expectedPlanId !== undefined && value.planId !== expectedPlanId) continue;
      latestById.set(`${value.planId}\u0000${value.id}`, {
        ...value,
        attachments: normalizeStoredAttachments(value.attachments),
        planAttachments: normalizeStoredPlanAttachments(value.planAttachments)
      } as PlanFeedbackRecord);
      } catch {
        // Keep other valid audit rows readable when one line is damaged.
      }
    }
  }
  return [...latestById.values()].sort((left, right) => {
    const dateDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}

export function updatePlanFeedbackDeliveryAsync(
  roleDir: string,
  record: PlanFeedbackRecord,
  deliveryStatus: "pending" | "delivered" | "failed",
  deliveryMessage?: string,
  signal?: AbortSignal
): Promise<PlanFeedbackRecord> {
  return appendPlanFeedbackAsync(roleDir, {
    ...record,
    updatedAt: new Date().toISOString(),
    deliveryStatus,
    deliveryMessage: optionalText(deliveryMessage)
  }, signal);
}

/**
 * Reads a pre-discovered set of feedback ledgers without probing every plan in a role.
 * The caller owns discovery and may therefore use bounded, asynchronous UNC I/O.
 */
export async function listPlanFeedbackFiles(
  filePaths: readonly string[],
  signal?: AbortSignal,
  concurrency = 8
): Promise<PlanFeedbackRecord[]> {
  signal?.throwIfAborted();
  const contents = new Array<string>(filePaths.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.floor(concurrency)), Math.max(1, filePaths.length)) },
    async () => {
      while (true) {
        signal?.throwIfAborted();
        const index = cursor++;
        if (index >= filePaths.length) return;
        try {
          contents[index] = await fs.promises.readFile(filePaths[index]!, { encoding: "utf8", signal });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            contents[index] = "";
            continue;
          }
          throw error;
        }
      }
    }
  ));
  signal?.throwIfAborted();
  return parsePlanFeedbackFiles(contents);
}

export function listPlanFeedbackAsync(
  roleDir: string,
  planId: string,
  signal?: AbortSignal
): Promise<PlanFeedbackRecord[]> {
  return listPlanFeedbackFiles(feedbackFiles(roleDir, planId), signal);
}

export function planFeedbackSummary(roleDir: string, planId: string): { count: number; latest?: PlanFeedbackRecord } {
  const records = listPlanFeedback(roleDir, planId);
  return { count: records.length, latest: records[0] };
}
