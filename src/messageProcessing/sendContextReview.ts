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

export type MessageProcessingSendContextReviewDependencies = {
  getRequirement: (requirementId: string) => MessageProcessingRequirement | undefined;
  findRequirementBySourceMessage: (routeId: string, messageId: string) => MessageProcessingRequirement | undefined;
  loadContext: (requirement: MessageProcessingRequirement) => MessageContextRecord[];
  now?: () => Date;
};

type ApprovedSendContext = {
  token: string;
  requirementId: string;
  contextVersion: string;
  reviewedByThreadId: string;
  sendFingerprint: string;
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

function contextItemsForRequirement(
  requirement: MessageProcessingRequirement,
  records: MessageContextRecord[]
): MessageProcessingSendContextItem[] {
  const sorted = records
    .filter((record) => !record.conversationKey || record.conversationKey === requirement.source.conversationKey)
    .sort((left, right) => left.time - right.time || Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  const sourceIds = sourceMessageIds(requirement);
  const selectedIndexes = new Set<number>();
  const sourceIndexes: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (sourceIds.has(cleanText(sorted[index]?.messageId))) sourceIndexes.push(index);
  }
  for (const index of sourceIndexes) {
    selectedIndexes.add(index);
    selectedIndexes.add(index - 1);
    selectedIndexes.add(index - 2);
    const replyTarget = cleanText(sorted[index]?.replyToMessageId);
    if (replyTarget) {
      const replyTargetIndex = sorted.findIndex((record) => cleanText(record.messageId) === replyTarget);
      if (replyTargetIndex >= 0) selectedIndexes.add(replyTargetIndex);
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

  snapshot(requirementId: string): MessageProcessingSendContextSnapshot {
    const requirement = this.dependencies.getRequirement(requirementId);
    if (!requirement) throw new Error(`Message processing requirement not found: ${requirementId}`);
    const records = this.dependencies.loadContext(requirement);
    const items = contextItemsForRequirement(requirement, records);
    const sourceIds = sourceMessageIds(requirement);
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
      requirementStatus: requirement.status,
      contextVersion: contextVersion(requirementId, items),
      contextItems: items,
      requiredReviewIds: items.map((item) => item.reviewId),
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
    const snapshot = this.snapshot(requirementId);
    if (snapshot.contextVersion !== cleanText(input.contextVersion)) {
      throw new Error("The conversation context changed before approval. GET the latest send-context and review again.");
    }
    const reviewed = new Set((input.reviewedContextIds || []).map(cleanText).filter(Boolean));
    const missing = snapshot.requiredReviewIds.filter((id) => !reviewed.has(id));
    if (missing.length > 0) {
      throw new Error(`Send-context review must cover every returned context item. Missing: ${missing.join(", ")}`);
    }
    if (snapshot.alreadyReplied && !input.intentionalFollowUp) {
      throw new Error("This message-processing requirement already has a sent reply. Do not approve another paraphrase.");
    }
    if (snapshot.requirementStatus !== "awaiting_send") {
      throw new Error(`Message-processing requirement must be awaiting_send before send-context approval; current status is ${snapshot.requirementStatus}.`);
    }
    const proposed = input.proposedSend;
    const prepared = prepareAgentSendRequest(proposed);
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
      if (!sourceMessageIds(requirement).has(replyToMessageId)) {
        throw new Error("The proposed group reply must quote one of the requirement source message IDs.");
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
      expiresAt
    });
    return { sendContextReviewToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  validateSend(request: AgentSendRequest): void {
    const prepared = prepareAgentSendRequest(request);
    const tracking = trackingFields(request);
    const replyToMessageId = prepared.channel === "napcat" && prepared.target.target === "group"
      ? cleanText(prepared.target.replyToMessageId)
      : "";
    const inferred = replyToMessageId
      ? this.dependencies.findRequirementBySourceMessage(prepared.routeId, replyToMessageId)
      : undefined;
    if (inferred && tracking.requirementId !== inferred.id) {
      throw new Error(
        `The quoted message belongs to message-processing requirement ${inferred.id}. `
        + "Use that tracking.requirementId and complete send-context review before sending."
      );
    }
    if (prepared.sender.agentType === "message_processing" && !tracking.requirementId) {
      throw new Error("message_processing sends require tracking.requirementId and a completed send-context review.");
    }
    if (!tracking.requirementId) return;
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
    const current = this.snapshot(requirement.id);
    if (current.contextVersion !== approval.contextVersion) {
      throw new Error("The conversation context changed after review. GET the latest send-context and review again.");
    }
  }
}
