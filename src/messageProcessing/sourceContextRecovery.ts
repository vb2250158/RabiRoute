import fs from "node:fs";
import path from "node:path";
import {
  messageContextFromHistoryRecord,
  recentMessageContextItems,
  type MessageContextRecord
} from "../messageContextStore.js";
import type { MessageProcessingRequirement } from "./board.js";

export type MessageProcessingSourceRecordEvidence = {
  record: Record<string, unknown>;
  contextRecord: MessageContextRecord;
  roleDir: string;
  routeId: string;
  groupId: string;
  instanceId?: string;
  sourceMessageId: string;
};

export type ReviewedMessageProcessingSourceRecordEvidence = MessageProcessingSourceRecordEvidence & {
  reviewedAttachmentIds: string[];
};

export type RecoverMessageProcessingSourceRecordOptions = {
  expectedGroupId?: string;
  expectedInstanceId?: string;
};

export type LoadMessageProcessingContextInput = {
  roleDir: string;
  requirement: MessageProcessingRequirement;
  sourceMessageId?: string;
  limit?: number;
  maxChars?: number;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function requirementRouteId(requirement: MessageProcessingRequirement): string {
  const routeId = text(requirement.source.routeProfileId) || text(requirement.source.routeId);
  const replyContext = objectValue(requirement.source.replyContext);
  const recordedRouteIds = [
    replyContext.runtimeRouteId,
    replyContext.gatewayId,
    replyContext.routeProfileId
  ].map(text).filter(Boolean);
  if (!routeId || recordedRouteIds.length === 0 || recordedRouteIds.some((item) => item !== routeId)) {
    throw new Error(`Cannot recover source context for ${requirement.id}: Route evidence is missing or conflicting.`);
  }
  return routeId;
}

function imageSegmentCount(record: Record<string, unknown>): number {
  const structured = Array.isArray(record.segments)
    ? record.segments.filter((segment) => segment && typeof segment === "object" && !Array.isArray(segment)
      && text((segment as Record<string, unknown>).type).toLowerCase() === "image").length
    : 0;
  const cq = [...text(record.rawMessage).matchAll(/\[CQ:image\b[^\]]*\]/gi)].length;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.filter((item) => item && typeof item === "object" && !Array.isArray(item)
      && text((item as Record<string, unknown>).kind).toLowerCase() === "image").length
    : 0;
  return Math.max(structured, cq, attachments);
}

export function recoverMessageProcessingSourceRecord(
  roleDirInput: string,
  requirement: MessageProcessingRequirement,
  sourceMessageIdInput: string,
  options: RecoverMessageProcessingSourceRecordOptions = {}
): MessageProcessingSourceRecordEvidence {
  const roleDir = path.resolve(roleDirInput);
  const sourceMessageId = text(sourceMessageIdInput);
  if (!sourceMessageId || !requirement.source.messageIds.map(text).includes(sourceMessageId)) {
    throw new Error(`Cannot recover source context: message ${sourceMessageId || "(empty)"} is not registered on requirement ${requirement.id}.`);
  }
  if (text(requirement.source.endpoint) !== "napcat") {
    throw new Error(`Cannot recover source context for ${requirement.id}: only NapCat group history is eligible.`);
  }
  const routeId = requirementRouteId(requirement);
  const matches = readJsonl(path.join(roleDir, "group-messages.jsonl"))
    .filter((record) => text(record.messageId ?? record.message_id) === sourceMessageId);
  if (matches.length !== 1) {
    throw new Error(
      `Cannot recover source context for ${sourceMessageId}: formal group history contains ${matches.length} matching records.`
    );
  }
  const record = matches[0]!;
  const recordedRouteIds = [record.runtimeRouteId, record.gatewayId, record.routeProfileId]
    .map(text)
    .filter(Boolean);
  if (recordedRouteIds.some((item) => item !== routeId)) {
    throw new Error(`Cannot recover source context for ${sourceMessageId}: formal Route evidence conflicts with ${routeId}.`);
  }
  const groupId = text(record.groupId ?? record.group_id);
  if (!groupId) {
    throw new Error(`Cannot recover source context for ${sourceMessageId}: formal group history has no groupId.`);
  }
  const expectedGroupId = text(options.expectedGroupId);
  if (expectedGroupId && groupId !== expectedGroupId) {
    throw new Error(
      `Cannot recover source context for ${sourceMessageId}: formal group ${groupId} does not match target group ${expectedGroupId}.`
    );
  }
  const instanceId = text(record.instanceId) || undefined;
  const expectedInstanceId = text(options.expectedInstanceId);
  if (expectedInstanceId && instanceId !== expectedInstanceId) {
    throw new Error(
      `Cannot recover source context for ${sourceMessageId}: formal instance ${instanceId || "(missing)"} does not match target instance ${expectedInstanceId}.`
    );
  }
  const contextRecord = messageContextFromHistoryRecord("group", {
    ...record,
    gatewayId: routeId,
    runtimeRouteId: routeId
  });
  if (!contextRecord || text(contextRecord.messageId) !== sourceMessageId || text(contextRecord.target) !== groupId) {
    throw new Error(`Cannot recover source context for ${sourceMessageId}: formal group history could not be normalized safely.`);
  }
  return {
    record,
    contextRecord,
    roleDir,
    routeId,
    groupId,
    instanceId,
    sourceMessageId
  };
}

export function recoverReviewedMessageProcessingSourceRecord(
  roleDirInput: string,
  requirement: MessageProcessingRequirement,
  sourceMessageIdInput: string,
  options: RecoverMessageProcessingSourceRecordOptions = {}
): ReviewedMessageProcessingSourceRecordEvidence {
  const recovered = recoverMessageProcessingSourceRecord(roleDirInput, requirement, sourceMessageIdInput, options);
  const imageCount = imageSegmentCount(recovered.record);
  if (imageCount === 0) return { ...recovered, reviewedAttachmentIds: [] };
  const formalAttachments = (Array.isArray(recovered.record.attachments) ? recovered.record.attachments : [])
    .flatMap((raw) => raw && typeof raw === "object" && !Array.isArray(raw)
      ? [raw as Record<string, unknown>]
      : [])
    .filter((item) => text(item.kind).toLowerCase() === "image");
  if (formalAttachments.length !== imageCount) {
    throw new Error(
      `Cannot recover reviewed source ${recovered.sourceMessageId}: formal image count ${imageCount} does not have matching attachment evidence.`
    );
  }
  const sourceAttachments = (requirement.source.attachments || [])
    .filter((item) => item.messageId === recovered.sourceMessageId && item.kind === "image");
  const sourceById = new Map(sourceAttachments.map((item) => [item.id, item]));
  const review = requirement.sourceEvidenceReview;
  const reviewedMessageIds = new Set((review?.reviewedMessageIds || []).map(text));
  if (!review?.replyChainChecked || !review.evidence || !review.reviewedAt
    || !reviewedMessageIds.has(recovered.sourceMessageId)) {
    throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: exact source evidence was not reviewed.`);
  }
  const attachmentReview = new Map((review.attachmentReviews || []).map((item) => [item.attachmentId, item]));
  const reviewedAttachmentIds: string[] = [];
  for (const formalAttachment of formalAttachments) {
    const attachmentId = text(formalAttachment.id);
    const sourceAttachment = sourceById.get(attachmentId);
    if (!attachmentId || !sourceAttachment) {
      throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: formal image attachment is not registered on the requirement.`);
    }
    if (text(formalAttachment.status) !== "ready" || sourceAttachment.status !== "ready") {
      throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: attachment ${attachmentId} is not ready.`);
    }
    const formalPath = text(formalAttachment.path);
    const registeredPath = text(sourceAttachment.path);
    if (!formalPath || !registeredPath || path.resolve(formalPath) !== path.resolve(registeredPath)) {
      throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: attachment ${attachmentId} path conflicts with formal evidence.`);
    }
    if (attachmentReview.get(attachmentId)?.status !== "reviewed") {
      throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: attachment ${attachmentId} was not reviewed.`);
    }
    reviewedAttachmentIds.push(attachmentId);
  }
  if (sourceAttachments.length !== reviewedAttachmentIds.length) {
    throw new Error(`Cannot recover reviewed source ${recovered.sourceMessageId}: requirement image evidence conflicts with formal history.`);
  }
  return { ...recovered, reviewedAttachmentIds };
}

export function loadMessageProcessingContext(input: LoadMessageProcessingContextInput): MessageContextRecord[] {
  const recent = recentMessageContextItems([input.roleDir], {
    conversationKey: input.requirement.source.conversationKey,
    limit: input.limit ?? 80,
    maxChars: input.maxChars ?? 24_000,
    includeArchives: true
  });
  const sourceMessageId = text(input.sourceMessageId);
  if (!sourceMessageId || recent.some((item) => text(item.messageId) === sourceMessageId)) return recent;
  const recovered = recoverMessageProcessingSourceRecord(input.roleDir, input.requirement, sourceMessageId).contextRecord;
  return [...recent, recovered];
}
