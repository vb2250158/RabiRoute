import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeStoredPlanAttachments } from "./planAttachments.js";
import {
  PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES,
  PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES,
  PLAN_FEEDBACK_MAX_ATTACHMENTS,
  type PlanFeedbackAttachment,
  type PlanFeedbackAttachmentUpload
} from "./shared/planFeedbackContract.js";
import type { PlanAttachment } from "./shared/planAttachmentContract.js";
import { safePlanStorageId } from "./planStorageLayout.js";
import {
  assertPlanStorageLeaseOwner,
  commitPlanStorageTransactionUnderLease,
  recoverPlanStorageTransactions,
  resolveCanonicalPlanStorageLocation,
  withPlanStorageLease,
  withPlanStorageLeaseAsync,
  type PlanStorageLease,
  type PlanStorageTransactionOperation,
  type PlanStorageTransactionRecoveryResult
} from "./planStorageRepository.js";
import type {
  PlanFeedbackCommitOptions,
  PlanFeedbackCommitResult,
  PlanFeedbackRecord
} from "./planFeedback.js";
import { storageRevisionToken } from "./shared/storageRevision.js";

type PreparedPlanFeedbackAttachment = {
  content: Buffer;
  fileName: string;
  metadata: PlanFeedbackAttachment;
};

type FeedbackLedgerSnapshot = {
  content: string;
  records: PlanFeedbackRecord[];
};

const FEEDBACK_LEDGER_RELATIVE_PATH = "feedback.jsonl";
const FEEDBACK_ATTACHMENTS_RELATIVE_PATH = "feedback-attachments";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileName(value: unknown, fallback: string): string {
  const base = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_");
  return (base || fallback).slice(0, 180);
}

function normalizeMimeType(value: unknown): string | undefined {
  const mimeType = String(value || "").trim().toLowerCase();
  return mimeType ? mimeType.slice(0, 160) : undefined;
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

export function normalizeStoredPlanFeedbackAttachments(value: unknown): PlanFeedbackAttachment[] {
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
  return attachmentSignature(normalizeStoredPlanFeedbackAttachments(left))
    === attachmentSignature(normalizeStoredPlanFeedbackAttachments(right));
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

function canonicalLocationUnderLease(lease: PlanStorageLease) {
  assertPlanStorageLeaseOwner(lease);
  const location = resolveCanonicalPlanStorageLocation(lease.roleDir, lease.planId);
  if (!location) throw new Error(`Canonical plan storage does not exist: ${lease.planId}`);
  assertPlanStorageLeaseOwner(lease);
  return location;
}

function feedbackAttachmentRelativeDirectory(feedbackId: string): string {
  return `${FEEDBACK_ATTACHMENTS_RELATIVE_PATH}/${safePlanStorageId(feedbackId) || "feedback"}`;
}

function relativeFeedbackAttachmentPath(filePath: string, planDirectory: string): string {
  if (!path.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
  const relative = path.relative(planDirectory, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
  const normalized = filePath.replace(/\\/g, "/");
  const marker = `/${FEEDBACK_ATTACHMENTS_RELATIVE_PATH}/`;
  const index = normalized.toLocaleLowerCase("en-US").indexOf(marker);
  if (index >= 0) return normalized.slice(index + 1);
  throw new Error(`Plan feedback attachment is outside canonical plan storage: ${filePath}`);
}

function storeRecordPaths(record: PlanFeedbackRecord, planDirectory: string): PlanFeedbackRecord {
  return {
    ...record,
    attachments: normalizeStoredPlanFeedbackAttachments(record.attachments).map((attachment) => ({
      ...attachment,
      path: relativeFeedbackAttachmentPath(attachment.path, planDirectory)
    }))
  };
}

function materializeAttachments(
  attachments: PlanFeedbackAttachment[],
  planDirectory: string
): PlanFeedbackAttachment[] {
  return normalizeStoredPlanFeedbackAttachments(attachments).map((attachment) => ({
      ...attachment,
      path: path.join(planDirectory, ...relativeFeedbackAttachmentPath(attachment.path, planDirectory).split("/"))
    }));
}

function materializeRecordPaths(record: PlanFeedbackRecord, planDirectory: string): PlanFeedbackRecord {
  return { ...record, attachments: materializeAttachments(record.attachments, planDirectory) };
}

function preparePlanFeedbackAttachments(
  lease: PlanStorageLease,
  feedbackId: string,
  value: unknown
): PreparedPlanFeedbackAttachment[] {
  if (!Array.isArray(value)) throw new Error("Approval feedback attachments must be an array.");
  if (value.length > PLAN_FEEDBACK_MAX_ATTACHMENTS) {
    throw new Error(`Approval feedback supports at most ${PLAN_FEEDBACK_MAX_ATTACHMENTS} attachments.`);
  }
  canonicalLocationUnderLease(lease);
  const relativeDirectory = feedbackAttachmentRelativeDirectory(feedbackId);
  let total = 0;
  return value.map((item, index) => {
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
    const fileName = `${String(index + 1).padStart(2, "0")}-${name}`;
    return {
      content,
      fileName,
      metadata: {
        kind: raw.kind === "image" || mimeType?.startsWith("image/") ? "image" : "file",
        name,
        path: `${relativeDirectory}/${fileName}`,
        size: content.byteLength,
        mimeType,
        sha256: sha256(content)
      }
    };
  });
}

function normalizeLedgerRecord(value: Partial<PlanFeedbackRecord>, expectedPlanId?: string): PlanFeedbackRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.id !== "string" || typeof value.planId !== "string"
    || typeof value.text !== "string" || typeof value.createdAt !== "string"
    || (expectedPlanId !== undefined && value.planId !== expectedPlanId)) {
    throw new Error("Plan feedback ledger contains an invalid record.");
  }
  return {
    ...value,
    attachments: normalizeStoredPlanFeedbackAttachments(value.attachments),
    planAttachments: normalizeStoredPlanAttachments(value.planAttachments)
  } as PlanFeedbackRecord;
}

function readFeedbackLedgerContent(content: string, source: string, expectedPlanId?: string): FeedbackLedgerSnapshot {
  const records: PlanFeedbackRecord[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      records.push(normalizeLedgerRecord(JSON.parse(line) as Partial<PlanFeedbackRecord>, expectedPlanId));
    } catch (error) {
      const detail = error instanceof SyntaxError ? "invalid JSON" : "an invalid record";
      throw new Error(`Plan feedback ledger contains ${detail} at line ${index + 1}: ${source}`);
    }
  }
  return { content, records };
}

function readFeedbackLedger(filePath: string, expectedPlanId?: string): FeedbackLedgerSnapshot {
  if (!fs.existsSync(filePath)) return { content: "", records: [] };
  return readFeedbackLedgerContent(fs.readFileSync(filePath, "utf8"), filePath, expectedPlanId);
}

function appendLedgerContent(snapshot: FeedbackLedgerSnapshot, record: PlanFeedbackRecord): Buffer {
  const separator = snapshot.content && !snapshot.content.endsWith("\n") ? "\n" : "";
  return Buffer.from(`${snapshot.content}${separator}${JSON.stringify(record)}\n`, "utf8");
}

function feedbackIdentitySignature(record: PlanFeedbackRecord): string {
  return sha256(JSON.stringify({
    id: record.id,
    roleId: record.roleId,
    planId: record.planId,
    stepId: record.stepId || "",
    kind: record.kind,
    author: record.author,
    text: record.text,
    attachments: attachmentSignature(normalizeStoredPlanFeedbackAttachments(record.attachments)),
    planAttachments: planAttachmentSignature(normalizeStoredPlanAttachments(record.planAttachments))
  }));
}

function feedbackStateSignature(record: PlanFeedbackRecord): string {
  const { updatedAt: _updatedAt, ...state } = record;
  return sha256(JSON.stringify({
    ...state,
    attachments: normalizeStoredPlanFeedbackAttachments(state.attachments),
    planAttachments: normalizeStoredPlanAttachments(state.planAttachments)
  }));
}

function transactionId(prefix: string, value: string): string {
  return `${prefix}-${sha256(value).slice(0, 64)}`;
}

export function commitPlanFeedbackUnderLease(
  lease: PlanStorageLease,
  inputRecord: PlanFeedbackRecord,
  attachmentUploads?: unknown,
  options: PlanFeedbackCommitOptions = {}
): PlanFeedbackCommitResult {
  if (inputRecord.planId !== lease.planId) {
    throw new Error(`Plan feedback lease does not own plan ${inputRecord.planId}.`);
  }
  const location = canonicalLocationUnderLease(lease);
  const ledgerPath = path.join(location.directory, FEEDBACK_LEDGER_RELATIVE_PATH);
  const snapshot = readFeedbackLedger(ledgerPath, inputRecord.planId);
  const sameId = snapshot.records.filter((record) => record.id === inputRecord.id);
  const latestExisting = sameId.at(-1);
  const prepared = attachmentUploads === undefined
    ? []
    : preparePlanFeedbackAttachments(lease, inputRecord.id, attachmentUploads);
  prepared.forEach((_item, index) => options.faultInjector?.("attachment_staged", index));
  let record: PlanFeedbackRecord = {
    ...inputRecord,
    attachments: attachmentUploads === undefined
      ? normalizeStoredPlanFeedbackAttachments(inputRecord.attachments)
      : prepared.map((item) => item.metadata),
    planAttachments: normalizeStoredPlanAttachments(inputRecord.planAttachments)
  };
  record = storeRecordPaths(record, location.directory);
  if (latestExisting && attachmentUploads === undefined && record.attachments.length === 0) {
    record = { ...record, attachments: latestExisting.attachments };
  }
  const identity = feedbackIdentitySignature(record);
  for (const existing of sameId) {
    if (feedbackIdentitySignature(existing) !== identity) {
      throw new Error(`Feedback id already exists with different content: ${record.id}`);
    }
  }
  if (latestExisting) return { record: materializeRecordPaths(latestExisting, location.directory), created: false };
  if (attachmentUploads === undefined && record.attachments.length > 0) {
    throw new Error(`New feedback attachments require upload bytes: ${record.id}`);
  }

  const operations: PlanStorageTransactionOperation[] = [];
  if (prepared.length > 0) {
    operations.push({
      type: "publish-directory",
      relativePath: feedbackAttachmentRelativeDirectory(record.id),
      files: prepared.map((item) => ({ relativePath: item.fileName, content: item.content }))
    });
  }
  operations.push({
    type: "replace-file",
    relativePath: FEEDBACK_LEDGER_RELATIVE_PATH,
    content: appendLedgerContent(snapshot, record)
  });
  const repositoryHooks = options.repositoryTransaction?.hooks;
  commitPlanStorageTransactionUnderLease(lease, {
    transactionId: transactionId("feedback", record.id),
    kind: "plan-feedback",
    semanticHash: identity,
    operations,
    hooks: {
      afterPayloadWrite(operationIndex, relativePath) {
        repositoryHooks?.afterPayloadWrite?.(operationIndex, relativePath);
      },
      afterOperation(operationIndex, operation) {
        repositoryHooks?.afterOperation?.(operationIndex, operation);
        if (operation === "publish-directory") options.faultInjector?.("attachments_committed");
        if (operation === "replace-file") options.faultInjector?.("feedback_committed");
      }
    }
  });
  const committedRecord = readFeedbackLedger(ledgerPath, inputRecord.planId).records
    .filter((item) => item.id === record.id)
    .at(-1);
  if (!committedRecord) throw new Error(`Plan feedback transaction did not publish its ledger row: ${record.id}`);
  return { record: materializeRecordPaths(committedRecord, location.directory), created: true };
}

export function commitPlanFeedback(
  roleDir: string,
  inputRecord: PlanFeedbackRecord,
  attachmentUploads?: unknown,
  options: PlanFeedbackCommitOptions = {}
): PlanFeedbackCommitResult {
  return withPlanStorageLease(roleDir, inputRecord.planId, (lease) =>
    commitPlanFeedbackUnderLease(lease, inputRecord, attachmentUploads, options)
  );
}

function appendPlanFeedbackUnderLease(
  lease: PlanStorageLease,
  inputRecord: PlanFeedbackRecord,
  expectedRevision?: string
): PlanFeedbackRecord {
  if (inputRecord.planId !== lease.planId) {
    throw new Error(`Plan feedback lease does not own plan ${inputRecord.planId}.`);
  }
  const location = canonicalLocationUnderLease(lease);
  const ledgerPath = path.join(location.directory, FEEDBACK_LEDGER_RELATIVE_PATH);
  const snapshot = readFeedbackLedger(ledgerPath, inputRecord.planId);
  const record = storeRecordPaths({
    ...inputRecord,
    attachments: normalizeStoredPlanFeedbackAttachments(inputRecord.attachments),
    planAttachments: normalizeStoredPlanAttachments(inputRecord.planAttachments)
  }, location.directory);
  const sameId = snapshot.records.filter((item) => item.id === record.id);
  for (const existing of sameId) {
    if (feedbackIdentitySignature(existing) !== feedbackIdentitySignature(record)) {
      throw new Error(`Feedback id already exists with different content: ${record.id}`);
    }
  }
  const latest = sameId.at(-1);
  if (expectedRevision !== undefined) {
    const currentRevision = storageRevisionToken(latest);
    if (expectedRevision !== currentRevision) {
      throw new Error(`STORAGE_MUTATION_REVISION_CONFLICT: expected=${expectedRevision}; current=${currentRevision ?? "absent"}.`);
    }
  }
  if (latest && feedbackStateSignature(latest) === feedbackStateSignature(record)) {
    return materializeRecordPaths(latest, location.directory);
  }
  const state = feedbackStateSignature(record);
  const transition = sha256(`${latest ? feedbackStateSignature(latest) : "initial"}:${state}`);
  commitPlanStorageTransactionUnderLease(lease, {
    transactionId: transactionId("feedback-revision", transition),
    kind: "plan-feedback-revision",
    semanticHash: transition,
    operations: [{
      type: "replace-file",
      relativePath: FEEDBACK_LEDGER_RELATIVE_PATH,
      content: appendLedgerContent(snapshot, record)
    }]
  });
  return materializeRecordPaths(record, location.directory);
}

export function appendPlanFeedback(
  roleDir: string,
  record: PlanFeedbackRecord,
  expectedRevision?: string
): PlanFeedbackRecord {
  return withPlanStorageLease(roleDir, record.planId, (lease) =>
    appendPlanFeedbackUnderLease(lease, record, expectedRevision));
}

export async function appendPlanFeedbackAsync(
  roleDir: string,
  record: PlanFeedbackRecord,
  signal?: AbortSignal,
  expectedRevision?: string
): Promise<PlanFeedbackRecord> {
  signal?.throwIfAborted();
  return withPlanStorageLeaseAsync(roleDir, record.planId, async (lease) => {
    signal?.throwIfAborted();
    return appendPlanFeedbackUnderLease(lease, record, expectedRevision);
  });
}

function latestRecords(snapshot: FeedbackLedgerSnapshot): PlanFeedbackRecord[] {
  const latestById = new Map<string, PlanFeedbackRecord>();
  for (const record of snapshot.records) latestById.set(`${record.planId}\u0000${record.id}`, record);
  return [...latestById.values()].sort((left, right) => {
    const dateDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}

export function listPlanFeedbackUnderLease(lease: PlanStorageLease): PlanFeedbackRecord[] {
  const location = canonicalLocationUnderLease(lease);
  return latestRecords(readFeedbackLedger(
    path.join(location.directory, FEEDBACK_LEDGER_RELATIVE_PATH),
    lease.planId
  )).map((record) => materializeRecordPaths(record, location.directory));
}

export function listPlanFeedback(roleDir: string, planId: string): PlanFeedbackRecord[] {
  return withPlanStorageLease(roleDir, planId, listPlanFeedbackUnderLease);
}

export async function listPlanFeedbackAsync(
  roleDir: string,
  planId: string,
  signal?: AbortSignal
): Promise<PlanFeedbackRecord[]> {
  signal?.throwIfAborted();
  return withPlanStorageLeaseAsync(roleDir, planId, async (lease) => {
    signal?.throwIfAborted();
    return listPlanFeedbackUnderLease(lease);
  });
}

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
  const records = contents.flatMap((content, index) =>
    readFeedbackLedgerContent(content || "", filePaths[index] || `feedback-ledger-${index}`).records
  );
  return latestRecords({ content: "", records });
}

export function recoverPlanFeedbackStoreTransactions(roleDir: string): PlanStorageTransactionRecoveryResult {
  const initial = recoverPlanStorageTransactions(roleDir, { kind: "plan-feedback" });
  const revisions = recoverPlanStorageTransactions(roleDir, { kind: "plan-feedback-revision" });
  return {
    committed: initial.committed + revisions.committed,
    alreadyCommitted: initial.alreadyCommitted + revisions.alreadyCommitted,
    failures: [...initial.failures, ...revisions.failures]
  };
}
