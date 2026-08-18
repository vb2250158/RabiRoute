import { createHash, randomUUID } from "node:crypto";
import { prepareAgentSendRequest, type AgentSendRequest } from "../agentSend.js";
import type { MessageContextRecord } from "../messageContextStore.js";
import type { MessageProcessingRequirement } from "./board.js";

const SEND_CONTEXT_REVIEW_TTL_MS = 2 * 60 * 1_000;
const MAX_CONTEXT_ITEMS = 40;

export type MessageProcessingSendContextItem = {
  reviewId: string;
  time: number;
  direction: MessageContextRecord["direction"];
  sender?: string;
  text: string;
  messageId?: string;
  replyToMessageId?: string;
};

export type MessageProcessingSendContextSnapshot = {
  requirementId: string;
  sourceMessageId?: string;
  requirementStatus: MessageProcessingRequirement["status"];
  contextVersion: string;
  contextItems: MessageProcessingSendContextItem[];
  requiredReviewIds: string[];
  alreadyReplied: boolean;
  priorReplies: MessageProcessingSendContextItem[];
};

export type MessageProcessingSendContextApprovalInput = {
  contextVersion: string;
  reviewedContextIds: string[];
  reviewedByThreadId: string;
  proposedSend: AgentSendRequest;
  intentionalFollowUp?: boolean;
  reason?: string;
};

export type MessageProcessingSendContextApproval = {
  sendContextReviewToken: string;
  expiresAt: string;
};

export type ValidatedMessageProcessingSendContext = {
  requirement: MessageProcessingRequirement;
  sourceMessageId?: string;
};

export type MessageProcessingSendContextReviewDependencies = {
  getRequirement: (requirementId: string) => MessageProcessingRequirement | undefined;
  findRequirementBySourceMessage: (routeId: string, messageId: string) => MessageProcessingRequirement | undefined;
  findRequirementsBySourceMessage?: (routeId: string, messageId: string) => MessageProcessingRequirement[];
  loadContext: (requirement: MessageProcessingRequirement, sourceMessageId?: string) => MessageContextRecord[];
  now?: () => Date;
};

type ApprovedSendContext = {
  token: string;
  requirementId: string;
  contextVersion: string;
  reviewedByThreadId: string;
  sendFingerprint: string;
  sourceMessageId?: string;
  expiresAt: number;
};

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reviewId(record: MessageContextRecord, index: number): string {
  return cleanText(record.messageId)
    || cleanText(record.id)
    || (Number.isFinite(record.sequence) ? `sequence:${record.sequence}` : `context:${record.time}:${index}`);
}

function sendFingerprint(request: AgentSendRequest): string {
  const tracking = request.tracking && typeof request.tracking === "object" && !Array.isArray(request.tracking)
    ? request.tracking as Record<string, unknown>
    : {};
  const { sendContextReviewToken: _reviewToken, ...stableTracking } = tracking;
  return createHash("sha256").update(stableJson({
    deliveryId: request.deliveryId,
    sender: request.sender,
    routeId: request.routeId,
    channel: request.channel,
    params: request.params,
    payload: request.payload,
    tracking: stableTracking
  }), "utf8").digest("hex");
}

function trackingFields(request: AgentSendRequest): { requirementId?: string; reviewToken?: string } {
  const tracking = request.tracking && typeof request.tracking === "object" && !Array.isArray(request.tracking)
    ? request.tracking as Record<string, unknown>
    : {};
  return {
    requirementId: cleanText(tracking.requirementId) || undefined,
    reviewToken: cleanText(tracking.sendContextReviewToken) || undefined
  };
}

function sourceMessageIds(requirement: MessageProcessingRequirement): Set<string> {
  return new Set(requirement.source.messageIds.map(cleanText).filter(Boolean));
}

function requirementsForSourceMessage(
  dependencies: MessageProcessingSendContextReviewDependencies,
  routeId: string,
  messageId: string
): MessageProcessingRequirement[] {
  const values = dependencies.findRequirementsBySourceMessage
    ? dependencies.findRequirementsBySourceMessage(routeId, messageId)
    : [dependencies.findRequirementBySourceMessage(routeId, messageId)].filter(Boolean) as MessageProcessingRequirement[];
  const unique = [...new Map(values.map((item) => [item.id, item])).values()];
  const candidates = unique.filter((item) => item.kind === "message_reply");
  if (candidates.length <= 1) return candidates;
  const canonicalRouteIds = new Set(candidates.map((item) =>
    cleanText(item.source.routeProfileId) || cleanText(item.source.routeId)));
  const messageGroupIds = new Set(candidates.map((item) =>
    cleanText(item.messageGroupId)
    || cleanText(item.source.replyContext?.messageGroupId)));
  const sameCanonicalSource = canonicalRouteIds.size === 1
    && canonicalRouteIds.has(routeId)
    && messageGroupIds.size === 1
    && !messageGroupIds.has("")
    && candidates.every((item) => sourceMessageIds(item).has(messageId));
  if (!sameCanonicalSource) return candidates;
  const sorted = [...candidates].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const newestCreatedAt = Date.parse(sorted[0]!.createdAt);
  const secondCreatedAt = Date.parse(sorted[1]!.createdAt);
  if (!Number.isFinite(newestCreatedAt)
    || !Number.isFinite(secondCreatedAt)
    || newestCreatedAt === secondCreatedAt) return candidates;
  return [sorted[0]!];
}

function contextItemsForRequirement(
  requirement: MessageProcessingRequirement,
  records: MessageContextRecord[],
  selectedSourceMessageId?: string
): MessageProcessingSendContextItem[] {
  const sourceIds = selectedSourceMessageId
    ? new Set([selectedSourceMessageId])
    : sourceMessageIds(requirement);
  const sorted = records
    .filter((record) => sourceIds.has(cleanText(record.messageId))
      || !record.conversationKey
      || record.conversationKey === requirement.source.conversationKey)
    .sort((left, right) => left.time - right.time || Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  const selectedIndexes = new Set<number>();
  const sourceIndexes: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (sourceIds.has(cleanText(sorted[index]?.messageId))) sourceIndexes.push(index);
  }
  for (const index of sourceIndexes) {
    selectedIndexes.add(index);
    selectedIndexes.add(index - 1);
    selectedIndexes.add(index - 2);
    let replyTarget = cleanText(sorted[index]?.replyToMessageId);
    const visited = new Set<string>();
    for (let depth = 0; replyTarget && depth < 10 && !visited.has(replyTarget); depth += 1) {
      visited.add(replyTarget);
      const replyTargetIndexes = sorted.flatMap((record, recordIndex) =>
        cleanText(record.messageId) === replyTarget ? [recordIndex] : []);
      for (const replyTargetIndex of replyTargetIndexes) selectedIndexes.add(replyTargetIndex);
      replyTarget = replyTargetIndexes.length === 1
        ? cleanText(sorted[replyTargetIndexes[0]!]?.replyToMessageId)
        : "";
    }
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const record = sorted[index]!;
    if (record.direction === "outbound" && sourceIds.has(cleanText(record.replyToMessageId))) {
      selectedIndexes.add(index);
    }
  }
  for (let index = sorted.length - 1; index >= 0 && selectedIndexes.size < MAX_CONTEXT_ITEMS; index -= 1) {
    selectedIndexes.add(index);
  }
  const indexes = [...selectedIndexes]
    .filter((index) => index >= 0 && index < sorted.length)
    .sort((left, right) => left - right);
  const boundedIndexes = indexes.length <= MAX_CONTEXT_ITEMS
    ? indexes
    : [...indexes.slice(0, Math.min(8, MAX_CONTEXT_ITEMS)), ...indexes.slice(-(MAX_CONTEXT_ITEMS - Math.min(8, MAX_CONTEXT_ITEMS)))];
  return boundedIndexes.map((recordIndex) => {
    const record = sorted[recordIndex]!;
    return {
      reviewId: reviewId(record, recordIndex),
      time: record.time,
      direction: record.direction,
      sender: cleanText(record.sender) || undefined,
      text: String(record.text ?? ""),
      messageId: cleanText(record.messageId) || undefined,
      replyToMessageId: cleanText(record.replyToMessageId) || undefined
    };
  });
}

function contextVersion(requirementId: string, items: MessageProcessingSendContextItem[]): string {
  return createHash("sha256").update(stableJson({ requirementId, items }), "utf8").digest("hex");
}

function uniqueContextItem(
  items: MessageProcessingSendContextItem[],
  messageId: string
): MessageProcessingSendContextItem {
  const matches = items.filter((item) => cleanText(item.messageId) === messageId);
  if (matches.length !== 1) {
    throw new Error(`The evidence subset cannot uniquely resolve source message ${messageId}; found ${matches.length} context records.`);
  }
  return matches[0]!;
}

function replyChainSubset(
  requirement: MessageProcessingRequirement,
  items: MessageProcessingSendContextItem[],
  sourceMessageId: string
): MessageProcessingSendContextItem[] {
  if (!sourceMessageIds(requirement).has(sourceMessageId)) {
    throw new Error("The proposed group reply must quote one of the requirement source message IDs.");
  }
  const allowed = new Set([
    ...requirement.source.messageIds.map(cleanText),
    ...(requirement.source.replyChainMessageIds || []).map(cleanText)
  ].filter(Boolean));
  const output: MessageProcessingSendContextItem[] = [];
  const visited = new Set<string>();
  let messageId = sourceMessageId;
  for (let depth = 0; messageId && depth < 10; depth += 1) {
    if (visited.has(messageId)) throw new Error(`The evidence subset contains a reply-chain cycle at ${messageId}.`);
    visited.add(messageId);
    const item = uniqueContextItem(items, messageId);
    output.push(item);
    const parent = cleanText(item.replyToMessageId);
    if (!parent) return output;
    if (!allowed.has(parent)) {
      throw new Error(`The reply chain for ${sourceMessageId} references ${parent}, which is outside the registered requirement evidence.`);
    }
    messageId = parent;
  }
  if (messageId) throw new Error(`The reply chain for ${sourceMessageId} exceeds the supported evidence depth.`);
  return output;
}

function payloadText(request: AgentSendRequest): string {
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
    ? request.payload as Record<string, unknown>
    : {};
  return cleanText(payload.text);
}

function referencedAttachments(
  requirement: MessageProcessingRequirement,
  sourceMessageId: string,
  chainMessageIds: Set<string>,
  body: string
): NonNullable<MessageProcessingRequirement["source"]["attachments"]> {
  const attachments = requirement.source.attachments || [];
  const selected = new Map(attachments
    .filter((attachment) => attachment.messageId === sourceMessageId)
    .map((attachment) => [attachment.id, attachment]));
  const chainAttachments = attachments.filter((attachment) =>
    attachment.messageId !== sourceMessageId && chainMessageIds.has(attachment.messageId));
  const normalizedBody = body.toLocaleLowerCase();
  for (const attachment of chainAttachments) {
    const keys = [attachment.id, attachment.name].map((value) => cleanText(value).toLocaleLowerCase()).filter(Boolean);
    if (keys.some((key) => normalizedBody.includes(key))) selected.set(attachment.id, attachment);
  }
  const hasGenericReference = /(?:图片|截图|图中|图里|附件|文件|视频|音频|录音|image|screenshot|attachment|file|video|audio)/i.test(body);
  const unmatched = chainAttachments.filter((attachment) => !selected.has(attachment.id));
  if (hasGenericReference && unmatched.length === 1) selected.set(unmatched[0]!.id, unmatched[0]!);
  if (hasGenericReference && unmatched.length > 1) {
    throw new Error(`The proposed body references an attachment, but the evidence subset is ambiguous: ${unmatched.map((item) => item.id).join(", ")}`);
  }
  return [...selected.values()];
}

function expectedChannel(endpoint: string): string {
  const normalized = endpoint.trim().toLowerCase();
  if (normalized === "qq") return "napcat";
  if (normalized === "rolepanel") return "role_panel";
  if (normalized === "planfeedback") return "plan_feedback";
  return normalized.split(":", 1)[0] || normalized;
}

export class MessageProcessingSendContextReview {
  private readonly approvals = new Map<string, ApprovedSendContext>();
  private readonly now: () => Date;

  constructor(private readonly dependencies: MessageProcessingSendContextReviewDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  snapshot(requirementId: string, sourceMessageIdInput?: string): MessageProcessingSendContextSnapshot {
    const requirement = this.dependencies.getRequirement(requirementId);
    if (!requirement) throw new Error(`Message processing requirement not found: ${requirementId}`);
    const sourceMessageId = cleanText(sourceMessageIdInput) || undefined;
    if (sourceMessageId && !sourceMessageIds(requirement).has(sourceMessageId)) {
      throw new Error(`Source message ${sourceMessageId} does not belong to message-processing requirement ${requirementId}.`);
    }
    const records = this.dependencies.loadContext(requirement, sourceMessageId);
    const items = contextItemsForRequirement(requirement, records, sourceMessageId);
    const sourceIds = sourceMessageId ? new Set([sourceMessageId]) : sourceMessageIds(requirement);
    const priorReplies = records
      .filter((record) =>
        (!record.conversationKey || record.conversationKey === requirement.source.conversationKey)
        && record.direction === "outbound"
        && sourceIds.has(cleanText(record.replyToMessageId)))
      .sort((left, right) => left.time - right.time || Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
      .slice(-MAX_CONTEXT_ITEMS)
      .map((record, index) => ({
        reviewId: reviewId(record, index),
        time: record.time,
        direction: record.direction,
        sender: cleanText(record.sender) || undefined,
        text: String(record.text ?? ""),
        messageId: cleanText(record.messageId) || undefined,
        replyToMessageId: cleanText(record.replyToMessageId) || undefined
      }));
    return {
      requirementId,
      sourceMessageId,
      requirementStatus: requirement.status,
      contextVersion: contextVersion(requirementId, items),
      contextItems: items,
      requiredReviewIds: sourceMessageId
        ? replyChainSubset(requirement, items, sourceMessageId).map((item) => item.reviewId)
        : items.map((item) => item.reviewId),
      alreadyReplied: requirement.status === "sent"
        || requirement.delivery?.status === "sent"
        || priorReplies.length > 0,
      priorReplies
    };
  }

  approve(
    requirementId: string,
    input: MessageProcessingSendContextApprovalInput
  ): MessageProcessingSendContextApproval {
    const proposed = input.proposedSend;
    const prepared = prepareAgentSendRequest(proposed);
    const sourceMessageId = prepared.channel === "napcat" && prepared.target.target === "group"
      ? cleanText(prepared.target.replyToMessageId)
      : "";
    const snapshot = this.snapshot(requirementId, sourceMessageId || undefined);
    if (snapshot.contextVersion !== cleanText(input.contextVersion)) {
      throw new Error("The conversation context changed before approval. GET the latest send-context and review again.");
    }
    if (snapshot.alreadyReplied && !input.intentionalFollowUp) {
      throw new Error("This message-processing requirement already has a sent reply to the proposed source. Do not approve another paraphrase.");
    }
    if (snapshot.requirementStatus !== "awaiting_send") {
      throw new Error(`Message-processing requirement must be awaiting_send before send-context approval; current status is ${snapshot.requirementStatus}.`);
    }
    const tracking = trackingFields(proposed);
    const reviewedByThreadId = cleanText(input.reviewedByThreadId);
    if (!reviewedByThreadId || prepared.sender.sessionId !== reviewedByThreadId) {
      throw new Error("Send-context review must be submitted by the same complete Agent session that will send the message.");
    }
    if (tracking.requirementId !== requirementId) {
      throw new Error(`The proposed send must include tracking.requirementId=${requirementId}.`);
    }
    const requirement = this.dependencies.getRequirement(requirementId)!;
    if (prepared.routeId !== (requirement.source.routeProfileId || requirement.source.routeId)) {
      throw new Error("The proposed send Route does not match the message-processing requirement source Route.");
    }
    if (prepared.channel !== expectedChannel(requirement.source.endpoint)) {
      throw new Error("The proposed send channel does not match the message-processing requirement source endpoint.");
    }
    if (prepared.channel === "napcat" && prepared.target.target === "group") {
      const replyToMessageId = cleanText(prepared.target.replyToMessageId);
      const ownerIds = requirementsForSourceMessage(this.dependencies, prepared.routeId, replyToMessageId)
        .map((owner) => owner.id);
      if (ownerIds.length !== 1) {
        throw new Error(`The quoted source belongs to conflicting message-processing requirements or none: ${ownerIds.join(", ") || "none"}.`);
      }
      if (ownerIds[0] !== requirement.id) {
        throw new Error(`The quoted source belongs to message-processing requirement ${ownerIds[0]}, not ${requirement.id}.`);
      }
      const chain = replyChainSubset(requirement, snapshot.contextItems, replyToMessageId);
      const reviewed = new Set((input.reviewedContextIds || []).map(cleanText).filter(Boolean));
      const missing = chain.map((item) => item.reviewId).filter((id) => !reviewed.has(id));
      if (missing.length > 0) {
        throw new Error(`Send-context review must cover the proposed source and explicit reply chain. Missing: ${missing.join(", ")}`);
      }
      const chainMessageIds = new Set(chain.map((item) => cleanText(item.messageId)).filter(Boolean));
      if (requirement.source.evidenceReviewRequired) {
        const sourceReview = requirement.sourceEvidenceReview;
        if (!sourceReview?.replyChainChecked || !sourceReview.evidence || !sourceReview.reviewedAt) {
          throw new Error("The proposed send requires a complete sourceEvidenceReview for its exact evidence subset.");
        }
        const sourceReviewed = new Set(sourceReview.reviewedMessageIds.map(cleanText));
        const missingSourceReview = [...chainMessageIds].filter((messageId) => !sourceReviewed.has(messageId));
        if (missingSourceReview.length > 0) {
          throw new Error(`sourceEvidenceReview does not cover the proposed evidence subset: ${missingSourceReview.join(", ")}`);
        }
        const attachmentReviewById = new Map(sourceReview.attachmentReviews.map((item) => [item.attachmentId, item]));
        const attachments = referencedAttachments(requirement, replyToMessageId, chainMessageIds, payloadText(proposed));
        const unavailable = attachments.filter((attachment) =>
          attachment.status !== "ready" || attachmentReviewById.get(attachment.id)?.status !== "reviewed");
        if (unavailable.length > 0) {
          throw new Error(`A referenced source attachment is unavailable or unreviewed: ${unavailable.map((item) => item.id).join(", ")}`);
        }
      }
      const factAssessment = requirement.projectFactAssessment;
      if (requirement.factAssessmentRequired || factAssessment) {
        if (!factAssessment?.replyChainChecked || !factAssessment.evidence || !factAssessment.assessedAt) {
          throw new Error("The proposed body requires a complete projectFactAssessment for its exact evidence subset.");
        }
        const factReviewed = new Set(factAssessment.reviewedMessageIds.map(cleanText));
        const missingFactReview = [...chainMessageIds].filter((messageId) => !factReviewed.has(messageId));
        if (missingFactReview.length > 0) {
          throw new Error(`projectFactAssessment does not cover the proposed body evidence subset: ${missingFactReview.join(", ")}`);
        }
      }
      if (input.intentionalFollowUp) {
        const params = proposed.params as Record<string, unknown>;
        if (params.allowAdditionalReply !== true || !cleanText(input.reason)) {
          throw new Error("An intentional follow-up requires params.allowAdditionalReply=true and a concrete review reason.");
        }
      }
    }
    const token = randomUUID();
    const expiresAt = this.now().getTime() + SEND_CONTEXT_REVIEW_TTL_MS;
    this.approvals.set(token, {
      token,
      requirementId,
      contextVersion: snapshot.contextVersion,
      reviewedByThreadId,
      sendFingerprint: sendFingerprint(proposed),
      sourceMessageId: sourceMessageId || undefined,
      expiresAt
    });
    return { sendContextReviewToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  validateSend(request: AgentSendRequest): ValidatedMessageProcessingSendContext | undefined {
    const prepared = prepareAgentSendRequest(request);
    const tracking = trackingFields(request);
    const replyToMessageId = prepared.channel === "napcat" && prepared.target.target === "group"
      ? cleanText(prepared.target.replyToMessageId)
      : "";
    const owners = replyToMessageId
      ? requirementsForSourceMessage(this.dependencies, prepared.routeId, replyToMessageId)
      : [];
    if (owners.length > 1) {
      throw new Error(`The quoted source belongs to conflicting message-processing requirements: ${owners.map((item) => item.id).join(", ")}.`);
    }
    const inferred = owners[0];
    if (inferred && tracking.requirementId !== inferred.id) {
      throw new Error(
        `The quoted message belongs to message-processing requirement ${inferred.id}. `
        + "Use that tracking.requirementId and complete send-context review before sending."
      );
    }
    if (prepared.sender.agentType === "message_processing" && !tracking.requirementId) {
      throw new Error("message_processing sends require tracking.requirementId and a completed send-context review.");
    }
    if (!tracking.requirementId) return undefined;
    const requirement = this.dependencies.getRequirement(tracking.requirementId);
    if (!requirement) throw new Error(`Message processing requirement not found: ${tracking.requirementId}`);
    if (requirement.status !== "awaiting_send") {
      throw new Error(`Message-processing requirement ${requirement.id} is ${requirement.status}, not awaiting_send.`);
    }
    if (!tracking.reviewToken) {
      throw new Error("A completed send-context review is required. Include tracking.sendContextReviewToken.");
    }
    const approval = this.approvals.get(tracking.reviewToken);
    if (!approval || approval.requirementId !== requirement.id) {
      throw new Error("The send-context review token is missing, expired, or belongs to another requirement.");
    }
    if (approval.expiresAt <= this.now().getTime()) {
      this.approvals.delete(approval.token);
      throw new Error("The send-context review expired. GET the latest send-context and review again.");
    }
    if (approval.reviewedByThreadId !== prepared.sender.sessionId) {
      throw new Error("The sending Agent session does not match the session that reviewed the latest context.");
    }
    if (approval.sendFingerprint !== sendFingerprint(request)) {
      throw new Error("The send request changed after context review. Review the exact payload and target again.");
    }
    const current = this.snapshot(requirement.id, approval.sourceMessageId);
    if (current.contextVersion !== approval.contextVersion) {
      throw new Error("The conversation context changed after review. GET the latest send-context and review again.");
    }
    return {
      requirement: structuredClone(requirement),
      sourceMessageId: approval.sourceMessageId
    };
  }
}
