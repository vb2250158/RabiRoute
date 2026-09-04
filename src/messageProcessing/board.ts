import { createHash, randomUUID } from "node:crypto";
import type { AgentSendResult } from "../agentSend.js";
import type { AgentReplyResult } from "../outbox.js";
import type { PlanItem } from "../roleKnowledge.js";
import type { MessageProcessingSourceAttachmentEvidence } from "./sourceEvidence.js";
import {
  JsonFileMessageProcessingBoardPersistence,
  type MessageProcessingBoardPersistence
} from "./persistence.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export const MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION = 2;
export const MESSAGE_PROCESSING_REQUIRED_DUE_MS = 10 * 60 * 1_000;
export const MESSAGE_PROCESSING_DECISION_DUE_MS = 30 * 60 * 1_000;
export const MESSAGE_PROCESSING_KNOWLEDGE_CALLBACK_DUE_MS = 60 * 60 * 1_000;
export const MESSAGE_PROCESSING_REQUIREMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MESSAGE_PROCESSING_TRANSIENT_RESULT_RETENTION_MS = 15 * 60 * 1_000;
export const MESSAGE_PROCESSING_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MESSAGE_PROCESSING_PLAN_ORIGIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type MessageProcessingRequirementKind =
  | "message_reply"
  | "plan_progress_notification";

export type MessageProcessingReplyPolicy = "required" | "agent_decides";

export type CriticalProjectFactKind =
  | "schedule"
  | "scope"
  | "approval"
  | "ownership"
  | "release";

export type CriticalProjectFactSignal = {
  kind: CriticalProjectFactKind;
  evidence: string;
};

export type ProjectFactAssessment = {
  status: "none" | "critical";
  reviewedMessageIds: string[];
  replyChainChecked: boolean;
  evidence: string;
  assessedAt: string;
  assessedByThreadId?: string;
  facts?: CriticalProjectFactSignal[];
};

export type MessageSourceAttachmentReview = {
  attachmentId: string;
  status: "reviewed" | "unavailable";
  observation: string;
};

export type MessageSourceEvidenceReview = {
  reviewedMessageIds: string[];
  replyChainChecked: boolean;
  attachmentReviews: MessageSourceAttachmentReview[];
  evidence: string;
  reviewedAt: string;
  reviewedByThreadId?: string;
};

export type KnowledgeRecallMatch = {
  id: string;
  title: string;
  type: "plan" | "recent_memory" | "consolidated_memory";
  endpoint: string;
  score: number;
  revisionAt: string;
};

export type KnowledgeHandlingActionType =
  | "reply"
  | "discuss"
  | "update_plan"
  | "update_memory"
  | "create_plan"
  | "create_memory"
  | "handoff"
  | "no_action";

export type KnowledgeHandlingAction = {
  type: KnowledgeHandlingActionType;
  recordType?: "plan" | "memory";
  recordId?: string;
  evidence: string;
  verifiedAt?: string;
};

export type KnowledgeMatchDisposition = {
  knowledgeId: string;
  knowledgeType: KnowledgeRecallMatch["type"];
  relevance: "relevant" | "not_relevant";
  evidence: string;
  actions: KnowledgeHandlingAction[];
};

export type KnowledgeMatchCallback = {
  knowledgeId: string;
  knowledgeType: KnowledgeRecallMatch["type"];
  result: "unchanged" | "updated" | "created" | "not_relevant" | "deferred";
  responseAction: "none" | "reply" | "discuss" | "handoff";
  evidence: string;
  recordType?: "plan" | "memory";
  recordId?: string;
  verifiedAt?: string;
  callbackAt: string;
  callbackByThreadId?: string;
};

export type CriticalProjectFactRecordReference =
  | { type: "plan"; planId: string }
  | { type: "memory"; memoryId: string }
  | { type: "document"; relativePath: string };

export type CriticalProjectFactDisposition = {
  status: "recorded" | "duplicate" | "not_applicable";
  record?: CriticalProjectFactRecordReference;
  evidence?: string;
  verifiedAt?: string;
};

export type MessageProcessingRequirementStatus =
  | "pending_dispatch"
  | "processing"
  | "handed_off"
  | "awaiting_send"
  | "awaiting_approval"
  | "fact_assessment_pending"
  | "fact_record_pending"
  | "sent"
  | "not_required"
  | "send_failed";

export type MessageProcessingSilenceReason =
  | "closing_only"
  | "duplicate"
  | "self_message"
  | "answered_by_other"
  | "message_withdrawn"
  | "superseded_by_followup"
  | "attachment_consumed"
  | "invalid_source"
  | "agent_judgement";

export type MessageProcessingSource = {
  routeId: string;
  routeProfileId?: string;
  roleId?: string;
  endpoint: string;
  conversationKey: string;
  sender: string;
  routeKinds: string[];
  messageIds: string[];
  evidenceReviewRequired?: boolean;
  replyChainMessageIds?: string[];
  attachments?: MessageProcessingSourceAttachmentEvidence[];
  summary?: string;
  replyContext?: Record<string, unknown>;
};

export type MessageProcessingWorker = {
  agentAdapter?: "codex" | "dsh";
  threadId: string;
  threadName: string;
  workspace: string;
  active?: boolean;
  runtimeStatus?: MessageProcessingWorkerRuntimeStatus;
  observedAt?: string;
};

export type MessageProcessingWorkerRuntimeStatus = "active" | "idle" | "notLoaded" | "unavailable";

export type MessageProcessingWorkerRuntimeObservation = {
  threadName?: string;
  workspace?: string;
  status: MessageProcessingWorkerRuntimeStatus;
  observedAt: string;
};

export type MessageProcessingDecision = {
  type: "reply" | "no_reply" | "handoff";
  reasonCode?: MessageProcessingSilenceReason;
  reason?: string;
  decidedAt: string;
  decidedByThreadId?: string;
};

export type MessageProcessingHandoff = {
  targetAgentType: string;
  targetThreadId?: string;
  targetThreadName?: string;
  acceptedAt: string;
  returnedAt?: string;
};

export type MessageProcessingDelivery = {
  deliveryId?: string;
  status: AgentReplyResult["status"];
  channel?: string;
  sentMessageId?: string;
  sentFileId?: string;
  sentFileName?: string;
  reason?: string;
  updatedAt: string;
};

export type MessageProcessingPlanChange = {
  planId: string;
  planTitle: string;
  beforeUpdatedAt?: string;
  afterUpdatedAt: string;
  changes: string[];
};

export type MessageProcessingRequirement = {
  id: string;
  dedupeKey: string;
  kind: MessageProcessingRequirementKind;
  replyPolicy: MessageProcessingReplyPolicy;
  status: MessageProcessingRequirementStatus;
  source: MessageProcessingSource;
  messageGroupId?: string;
  plan?: MessageProcessingPlanChange;
  worker?: MessageProcessingWorker;
  decision?: MessageProcessingDecision;
  handoff?: MessageProcessingHandoff;
  delivery?: MessageProcessingDelivery;
  factAssessmentRequired?: boolean;
  projectFactAssessment?: ProjectFactAssessment;
  sourceEvidenceReview?: MessageSourceEvidenceReview;
  knowledgeMatches?: KnowledgeRecallMatch[];
  knowledgeMatchDispositions?: KnowledgeMatchDisposition[];
  knowledgeCallbacks?: KnowledgeMatchCallback[];
  knowledgeCallbackDueAt?: string;
  lastKnowledgeReminderAt?: string;
  criticalFacts?: CriticalProjectFactSignal[];
  criticalFactDisposition?: CriticalProjectFactDisposition;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  lastError?: string;
};

export type MessageProcessingPlanOrigin = {
  key: string;
  roleId: string;
  planId: string;
  planTitle?: string;
  sourceRequirementId: string;
  source: MessageProcessingSource;
  worker?: MessageProcessingWorker;
  lastObservedPlanUpdatedAt?: string;
  lastPlan?: MessageProcessingPlanSnapshot;
  linkedAt: string;
};

export type MessageProcessingPlanSnapshot = {
  updatedAt: string;
  status: PlanItem["status"];
  currentStep?: string;
  currentStepId?: string;
  nextAction?: string;
  waitingFor?: string;
  isBlocked?: boolean;
  blockedBy?: string;
  stepsSignature: string;
};

export type MessageProcessingDedupeRecord = {
  key: string;
  expiresAt: string;
};

export type MessageProcessingBoardState = {
  schemaVersion: typeof MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION;
  updatedAt: string;
  requirements: MessageProcessingRequirement[];
  planOrigins: MessageProcessingPlanOrigin[];
  dedupeRecords: MessageProcessingDedupeRecord[];
};

export type MessageProcessingBoardPruneResult = {
  requirements: number;
  planOrigins: number;
};

export type RegisterMessageGroupRequirementInput = {
  requirementId: string;
  messageGroupId: string;
  source: MessageProcessingSource;
  knowledgeMatches?: KnowledgeRecallMatch[];
};

export type MessageProcessingOutcomeInput = {
  decision: "reply" | "no_reply" | "handoff";
  reasonCode?: MessageProcessingSilenceReason;
  reason?: string;
  decidedByThreadId?: string;
  targetAgentType?: string;
  targetThreadId?: string;
  targetThreadName?: string;
  roleId?: string;
  planId?: string;
  planTitle?: string;
  projectFactAssessment?: ProjectFactAssessment;
  sourceEvidenceReview?: MessageSourceEvidenceReview;
  knowledgeMatchDispositions?: KnowledgeMatchDisposition[];
  criticalFactDisposition?: CriticalProjectFactDisposition;
};

export type KnowledgeMatchCallbackInput = Omit<KnowledgeMatchCallback, "callbackAt"> & { callbackAt?: string };

export type MessageProcessingGroupRegistrationResult =
  | { outcome: "created" | "existing"; requirement: MessageProcessingRequirement }
  | { outcome: "replay_suppressed"; dedupeKey: string };

const allowedRequiredSilenceReasons = new Set<MessageProcessingSilenceReason>([
  "closing_only",
  "duplicate",
  "self_message",
  "answered_by_other",
  "message_withdrawn",
  "superseded_by_followup",
  "attachment_consumed",
  "invalid_source"
]);

function normalizeCriticalFacts(value: unknown): CriticalProjectFactSignal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return [];
    const candidate = signal as Partial<CriticalProjectFactSignal>;
    const kind = String(candidate.kind || "") as CriticalProjectFactKind;
    const evidence = cleanText(candidate.evidence, 4_000);
    return new Set<CriticalProjectFactKind>(["schedule", "scope", "approval", "ownership", "release"]).has(kind) && evidence
      ? [{ kind, evidence }]
      : [];
  });
}

function normalizeProjectFactAssessment(value: unknown): ProjectFactAssessment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<ProjectFactAssessment>;
  if (item.status !== "none" && item.status !== "critical") return undefined;
  const facts = normalizeCriticalFacts(item.facts);
  return {
    status: item.status,
    reviewedMessageIds: stringList(item.reviewedMessageIds, 100),
    replyChainChecked: item.replyChainChecked === true,
    evidence: cleanText(item.evidence, 4_000) || "",
    assessedAt: cleanText(item.assessedAt, 100) || "",
    assessedByThreadId: cleanText(item.assessedByThreadId, 100),
    facts: facts.length ? facts : undefined
  };
}

function normalizeSourceAttachmentReviews(value: unknown): MessageSourceAttachmentReview[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<MessageSourceAttachmentReview>;
    const attachmentId = cleanText(item.attachmentId, 300);
    const observation = cleanText(item.observation, 2_000);
    if (!attachmentId || !observation || (item.status !== "reviewed" && item.status !== "unavailable")) return [];
    return [{ attachmentId, status: item.status, observation }];
  });
}

function normalizeSourceEvidenceReview(value: unknown): MessageSourceEvidenceReview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<MessageSourceEvidenceReview>;
  return {
    reviewedMessageIds: stringList(item.reviewedMessageIds, 200),
    replyChainChecked: item.replyChainChecked === true,
    attachmentReviews: normalizeSourceAttachmentReviews(item.attachmentReviews),
    evidence: cleanText(item.evidence, 4_000) || "",
    reviewedAt: cleanText(item.reviewedAt, 100) || "",
    reviewedByThreadId: cleanText(item.reviewedByThreadId, 100)
  };
}

function validateSourceEvidenceReview(
  requirement: MessageProcessingRequirement,
  input: MessageProcessingOutcomeInput
): MessageSourceEvidenceReview | undefined {
  if (requirement.kind !== "message_reply" || input.decision === "handoff" || !requirement.source.evidenceReviewRequired) return undefined;
  const review = normalizeSourceEvidenceReview(input.sourceEvidenceReview) || requirement.sourceEvidenceReview;
  if (!review) throw new Error("Message Agent must submit sourceEvidenceReview before closing or replying.");
  if (!review.replyChainChecked || !review.evidence || !review.reviewedAt) {
    throw new Error("sourceEvidenceReview requires replyChainChecked=true, evidence, and reviewedAt.");
  }
  const reviewed = new Set(review.reviewedMessageIds);
  const requiredMessageIds = [...requirement.source.messageIds, ...(requirement.source.replyChainMessageIds || [])];
  const unknownMessages = review.reviewedMessageIds.filter((messageId) => !requiredMessageIds.includes(messageId));
  if (unknownMessages.length > 0) {
    throw new Error(`sourceEvidenceReview contains messageIds outside this requirement: ${unknownMessages.join(", ")}`);
  }
  const attachments = requirement.source.attachments || [];
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const unknownAttachments = review.attachmentReviews.filter((item) => !attachmentById.has(item.attachmentId));
  if (unknownAttachments.length > 0) {
    throw new Error(`sourceEvidenceReview contains attachments outside this requirement: ${unknownAttachments.map((item) => item.attachmentId).join(", ")}`);
  }
  if (input.decision === "reply") return review;
  const missingMessages = requiredMessageIds.filter((messageId) => !reviewed.has(messageId));
  if (missingMessages.length > 0) {
    throw new Error(`sourceEvidenceReview must cover every source and reply-chain messageId. Missing: ${missingMessages.join(", ")}`);
  }
  const reviewById = new Map(review.attachmentReviews.map((item) => [item.attachmentId, item]));
  const missingAttachments = attachments.filter((attachment) => !reviewById.has(attachment.id));
  if (missingAttachments.length > 0) {
    throw new Error(`sourceEvidenceReview must cover every attachment. Missing: ${missingAttachments.map((item) => item.id).join(", ")}`);
  }
  const unavailable = attachments.filter((attachment) => attachment.status !== "ready");
  if (unavailable.length > 0) {
    throw new Error(`Source attachment is unavailable and cannot be answered by inference. Handoff or retry attachment retrieval: ${unavailable.map((item) => item.id).join(", ")}`);
  }
  const notReviewed = attachments.filter((attachment) => reviewById.get(attachment.id)?.status !== "reviewed");
  if (notReviewed.length > 0) {
    throw new Error(`Readable source attachments must be marked reviewed with a concrete observation: ${notReviewed.map((item) => item.id).join(", ")}`);
  }
  return review;
}

function validateProjectFactAssessment(
  requirement: MessageProcessingRequirement,
  input: MessageProcessingOutcomeInput
): ProjectFactAssessment | undefined {
  if (requirement.kind !== "message_reply" || input.decision === "handoff" || !requirement.factAssessmentRequired) return undefined;
  const assessment = normalizeProjectFactAssessment(input.projectFactAssessment) || requirement.projectFactAssessment;
  if (!assessment) throw new Error("Message Agent must submit projectFactAssessment before closing or replying.");
  if (!assessment.replyChainChecked || !assessment.evidence || !assessment.assessedAt) {
    throw new Error("projectFactAssessment requires replyChainChecked=true, evidence, and assessedAt.");
  }
  const allowedMessageIds = new Set([...requirement.source.messageIds, ...(requirement.source.replyChainMessageIds || [])]);
  const unknown = assessment.reviewedMessageIds.filter((messageId) => !allowedMessageIds.has(messageId));
  if (unknown.length) throw new Error(`projectFactAssessment contains messageIds outside this requirement: ${unknown.join(", ")}`);
  if (input.decision !== "reply") {
    const reviewed = new Set(assessment.reviewedMessageIds);
    const missing = requirement.source.messageIds.filter((messageId) => !reviewed.has(messageId));
    if (missing.length) throw new Error(`projectFactAssessment must cover every source messageId. Missing: ${missing.join(", ")}`);
  }
  if (assessment.status === "critical" && !assessment.facts?.length) {
    throw new Error("A critical projectFactAssessment requires at least one Agent-classified fact.");
  }
  if (assessment.status === "none" && assessment.facts?.length) {
    throw new Error("A none projectFactAssessment cannot include critical facts.");
  }
  return assessment;
}

function normalizeKnowledgeMatches(value: unknown): KnowledgeRecallMatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<KnowledgeRecallMatch>;
    const type = String(item.type || "") as KnowledgeRecallMatch["type"];
    const id = cleanText(item.id, 500);
    const title = cleanText(item.title, 1_000);
    const endpoint = cleanText(item.endpoint, 2_000);
    const revisionAt = cleanText(item.revisionAt, 100);
    const score = Number(item.score);
    if (!id || !title || !endpoint || !revisionAt || !Number.isFinite(score)) return [];
    if (!new Set(["plan", "recent_memory", "consolidated_memory"]).has(type)) return [];
    return [{ id, title, type, endpoint, score, revisionAt }];
  });
}

function normalizeKnowledgeActions(value: unknown): KnowledgeHandlingAction[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<KnowledgeHandlingActionType>([
    "reply", "discuss", "update_plan", "update_memory", "create_plan", "create_memory", "handoff", "no_action"
  ]);
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<KnowledgeHandlingAction>;
    const type = String(item.type || "") as KnowledgeHandlingActionType;
    const evidence = cleanText(item.evidence, 4_000);
    if (!allowed.has(type) || !evidence) return [];
    const recordType = item.recordType === "plan" || item.recordType === "memory" ? item.recordType : undefined;
    return [{
      type,
      recordType,
      recordId: cleanText(item.recordId, 500),
      evidence,
      verifiedAt: cleanText(item.verifiedAt, 100)
    }];
  });
}

function normalizeKnowledgeMatchDispositions(value: unknown): KnowledgeMatchDisposition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<KnowledgeMatchDisposition>;
    const knowledgeId = cleanText(item.knowledgeId, 500);
    const knowledgeType = String(item.knowledgeType || "") as KnowledgeRecallMatch["type"];
    const relevance = item.relevance === "relevant" || item.relevance === "not_relevant" ? item.relevance : undefined;
    const evidence = cleanText(item.evidence, 4_000);
    const actions = normalizeKnowledgeActions(item.actions);
    if (!knowledgeId || !new Set(["plan", "recent_memory", "consolidated_memory"]).has(knowledgeType) || !relevance || !evidence) return [];
    return [{ knowledgeId, knowledgeType, relevance, evidence, actions }];
  });
}

function normalizeKnowledgeCallbacks(value: unknown): KnowledgeMatchCallback[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<KnowledgeMatchCallback>;
    const knowledgeId = cleanText(item.knowledgeId, 500);
    const knowledgeType = String(item.knowledgeType || "") as KnowledgeRecallMatch["type"];
    const result = new Set(["unchanged", "updated", "created", "not_relevant", "deferred"]).has(String(item.result))
      ? item.result as KnowledgeMatchCallback["result"]
      : undefined;
    const responseAction = new Set(["none", "reply", "discuss", "handoff"]).has(String(item.responseAction))
      ? item.responseAction as KnowledgeMatchCallback["responseAction"]
      : undefined;
    const evidence = cleanText(item.evidence, 4_000);
    const callbackAt = cleanText(item.callbackAt, 100);
    if (!knowledgeId || !new Set(["plan", "recent_memory", "consolidated_memory"]).has(knowledgeType) || !result || !responseAction || !evidence || !callbackAt) return [];
    return [{
      knowledgeId,
      knowledgeType,
      result,
      responseAction,
      evidence,
      recordType: item.recordType === "plan" || item.recordType === "memory" ? item.recordType : undefined,
      recordId: cleanText(item.recordId, 500),
      verifiedAt: cleanText(item.verifiedAt, 100),
      callbackAt,
      callbackByThreadId: cleanText(item.callbackByThreadId, 100)
    }];
  });
}

function callbackIsFinal(callback: KnowledgeMatchCallback | undefined): boolean {
  return Boolean(callback && callback.result !== "deferred");
}

function validateKnowledgeMatchDispositions(
  requirement: MessageProcessingRequirement,
  input: MessageProcessingOutcomeInput
): KnowledgeMatchDisposition[] | undefined {
  if (requirement.kind !== "message_reply" || input.decision === "handoff" || !requirement.factAssessmentRequired) return undefined;
  const matches = requirement.knowledgeMatches || [];
  const callbackById = new Map((requirement.knowledgeCallbacks || []).map((item) => [`${item.knowledgeType}:${item.knowledgeId}`, item]));
  if (matches.every((match) => callbackIsFinal(callbackById.get(`${match.type}:${match.id}`)))) {
    for (const callback of callbackById.values()) {
      if ((callback.responseAction === "reply" || callback.responseAction === "discuss") && input.decision !== "reply") {
        throw new Error(`${callback.responseAction} callback requires decision=reply for recalled item ${callback.knowledgeId}.`);
      }
    }
    return requirement.knowledgeMatchDispositions;
  }
  const dispositions = normalizeKnowledgeMatchDispositions(input.knowledgeMatchDispositions);
  const byId = new Map(dispositions.map((item) => [`${item.knowledgeType}:${item.knowledgeId}`, item]));
  const missing = matches.filter((match) => !byId.has(`${match.type}:${match.id}`));
  if (missing.length) {
    throw new Error(`Every recalled plan or memory requires a knowledgeMatchDisposition. Missing: ${missing.map((item) => item.id).join(", ")}`);
  }
  const unexpected = dispositions.filter((item) => !matches.some((match) => match.id === item.knowledgeId && match.type === item.knowledgeType));
  if (unexpected.length) throw new Error(`knowledgeMatchDisposition contains items that were not recalled: ${unexpected.map((item) => item.knowledgeId).join(", ")}`);
  for (const disposition of dispositions) {
    if (!disposition.actions.length) throw new Error(`knowledgeMatchDisposition ${disposition.knowledgeId} requires at least one action.`);
    if (disposition.relevance === "not_relevant" && disposition.actions.some((action) => action.type !== "no_action")) {
      throw new Error(`A not_relevant recall may only use no_action: ${disposition.knowledgeId}`);
    }
    if (disposition.relevance === "relevant" && disposition.actions.every((action) => action.type === "no_action")) {
      throw new Error(`A relevant recall requires reply, discussion, plan/memory update, creation, or handoff: ${disposition.knowledgeId}`);
    }
    for (const action of disposition.actions) {
      if ((action.type === "reply" || action.type === "discuss") && input.decision !== "reply") {
        throw new Error(`${action.type} requires decision=reply for recalled item ${disposition.knowledgeId}.`);
      }
      if (["update_plan", "update_memory", "create_plan", "create_memory"].includes(action.type)) {
        if (!action.recordId || !action.recordType || !action.verifiedAt) {
          throw new Error(`${action.type} requires recordType, recordId, evidence, and verifiedAt for recalled item ${disposition.knowledgeId}.`);
        }
        if ((action.type.endsWith("plan") && action.recordType !== "plan") || (action.type.endsWith("memory") && action.recordType !== "memory")) {
          throw new Error(`${action.type} has an incompatible recordType for recalled item ${disposition.knowledgeId}.`);
        }
      }
    }
  }
  return dispositions;
}

function normalizeCriticalFactDisposition(value: unknown): CriticalProjectFactDisposition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<CriticalProjectFactDisposition> & {
    recordType?: string;
    recordId?: string;
  };
  if (!new Set(["recorded", "duplicate", "not_applicable"]).has(String(item.status))) return undefined;
  const rawRecord = item.record && typeof item.record === "object" && !Array.isArray(item.record)
    ? item.record as Partial<CriticalProjectFactRecordReference> & Record<string, unknown>
    : undefined;
  const legacyId = cleanText(item.recordId, 500);
  const record = rawRecord?.type === "plan" && cleanText(rawRecord.planId, 500)
    ? { type: "plan" as const, planId: cleanText(rawRecord.planId, 500)! }
    : rawRecord?.type === "memory" && cleanText(rawRecord.memoryId, 500)
      ? { type: "memory" as const, memoryId: cleanText(rawRecord.memoryId, 500)! }
      : rawRecord?.type === "document" && cleanText(rawRecord.relativePath, 500)
        ? { type: "document" as const, relativePath: cleanText(rawRecord.relativePath, 500)! }
        : item.recordType === "plan" && legacyId
          ? { type: "plan" as const, planId: legacyId }
          : item.recordType === "memory" && legacyId
            ? { type: "memory" as const, memoryId: legacyId }
            : item.recordType === "document" && legacyId
              ? { type: "document" as const, relativePath: legacyId }
              : undefined;
  return {
    status: item.status as CriticalProjectFactDisposition["status"],
    record,
    evidence: cleanText(item.evidence, 2_000),
    verifiedAt: cleanText(item.verifiedAt, 100)
  };
}

function validateCriticalFactDisposition(
  requirement: MessageProcessingRequirement,
  input: MessageProcessingOutcomeInput
): CriticalProjectFactDisposition | undefined {
  if (input.decision === "handoff") return undefined;
  const facts = requirement.projectFactAssessment?.status === "critical"
    ? requirement.projectFactAssessment.facts || []
    : input.projectFactAssessment?.status === "critical"
      ? normalizeCriticalFacts(input.projectFactAssessment.facts)
      : requirement.criticalFacts || [];
  if (!facts.length) return undefined;
  const disposition = normalizeCriticalFactDisposition(input.criticalFactDisposition);
  if (!disposition) {
    throw new Error("This message contains a critical project fact. Record and verify it in a plan, memory, or project document before closing or replying; otherwise hand it off.");
  }
  if (disposition.status === "not_applicable") {
    if (!disposition.evidence) throw new Error("criticalFactDisposition.not_applicable requires evidence explaining the false positive.");
    return disposition;
  }
  if (!disposition.record || !disposition.evidence || !disposition.verifiedAt) {
    throw new Error("criticalFactDisposition requires a typed record reference, evidence, and verifiedAt for recorded or duplicate facts.");
  }
  return disposition;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function cleanText(value: unknown, maxLength = 2_000): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function reasonContainsNamedMessageReference(reason: string): boolean {
  return /(?:messageId|sentMessageId|replyTo|sourceMessageId)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/i.test(reason);
}

function reasonContainsSourceMessageId(reason: string, messageIds: string[]): boolean {
  return messageIds.some((messageId) => messageId && reason.includes(messageId));
}

function stringList(value: unknown, maxItems = 100): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(-maxItems)
    : [];
}

function messageSourceDedupeKey(source: MessageProcessingSource): string {
  const identity = JSON.stringify({
    routeId: source.routeId,
    endpoint: source.endpoint,
    conversationKey: source.conversationKey,
    messageIds: [...new Set(source.messageIds)].sort()
  });
  return createHash("sha256").update(identity).digest("hex");
}

function requirementRetentionMs(requirement: MessageProcessingRequirement): number {
  if (["sent", "not_required", "send_failed"].includes(requirement.status)) {
    return MESSAGE_PROCESSING_TRANSIENT_RESULT_RETENTION_MS;
  }
  return MESSAGE_PROCESSING_REQUIREMENT_RETENTION_MS;
}

function normalizeDedupeRecord(value: unknown): MessageProcessingDedupeRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<MessageProcessingDedupeRecord>;
  const key = cleanText(record.key, 128);
  const expiresAt = cleanText(record.expiresAt, 100);
  if (!key || !/^[a-f0-9]{64}$/i.test(key) || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return undefined;
  return { key, expiresAt };
}

function normalizeSource(value: unknown): MessageProcessingSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<MessageProcessingSource>;
  const routeId = cleanText(source.routeId, 200);
  const endpoint = cleanText(source.endpoint, 120);
  const conversationKey = cleanText(source.conversationKey, 500);
  const sender = cleanText(source.sender, 500);
  if (!routeId || !endpoint || !conversationKey || !sender) return undefined;
  return {
    routeId,
    routeProfileId: cleanText(source.routeProfileId, 200),
    roleId: cleanText(source.roleId, 200),
    endpoint,
    conversationKey,
    sender,
    routeKinds: stringList(source.routeKinds, 20),
    messageIds: stringList(source.messageIds, 100),
    evidenceReviewRequired: source.evidenceReviewRequired === true,
    replyChainMessageIds: stringList(source.replyChainMessageIds, 100),
    attachments: Array.isArray(source.attachments) ? source.attachments.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as Partial<MessageProcessingSourceAttachmentEvidence>;
      const id = cleanText(item.id, 300);
      const messageId = cleanText(item.messageId, 300);
      const name = cleanText(item.name, 500);
      const kind = item.kind === "video" || item.kind === "audio" || item.kind === "file" ? item.kind : "image";
      if (!id || !messageId || !name) return [];
      return [{
        id,
        messageId,
        kind,
        name,
        mimeType: cleanText(item.mimeType, 200),
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
        path: cleanText(item.path, 2_000),
        status: item.status === "ready" ? "ready" as const : "unavailable" as const,
        error: cleanText(item.error, 2_000)
      }];
    }) : undefined,
    summary: cleanText(source.summary, 4_000),
    replyContext: source.replyContext && typeof source.replyContext === "object" && !Array.isArray(source.replyContext)
      ? source.replyContext as Record<string, unknown>
      : undefined
  };
}

function messageReplyPolicy(source: MessageProcessingSource): MessageProcessingReplyPolicy {
  const explicitKinds = new Set(["private", "direct_at", "direct_reply", "role_panel_message"]);
  if (source.routeKinds.some((kind) => explicitKinds.has(kind))) return "required";
  if (String(source.replyContext?.targetType || "") === "private") return "required";
  return "agent_decides";
}

function normalizedWorker(value: unknown): MessageProcessingWorker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const worker = value as Partial<MessageProcessingWorker>;
  const threadId = cleanText(worker.threadId, 100);
  const threadName = cleanText(worker.threadName, 300);
  const workspace = cleanText(worker.workspace, 2_000);
  if (!threadId || !threadName || !workspace) return undefined;
  return {
    agentAdapter: worker.agentAdapter === "dsh" || threadId.startsWith("session-") ? "dsh" : "codex",
    threadId,
    threadName,
    workspace
  };
}

function normalizeRequirement(value: unknown): MessageProcessingRequirement | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<MessageProcessingRequirement>;
  const source = normalizeSource(item.source);
  if (!item.id || !item.dedupeKey || !source || !item.createdAt || !item.updatedAt || !item.dueAt) return undefined;
  const kind: MessageProcessingRequirementKind = item.kind === "plan_progress_notification"
    ? "plan_progress_notification"
    : "message_reply";
  const replyPolicy: MessageProcessingReplyPolicy = item.replyPolicy === "required" ? "required" : "agent_decides";
  const statuses = new Set<MessageProcessingRequirementStatus>([
    "pending_dispatch", "processing", "handed_off", "awaiting_send", "awaiting_approval", "fact_assessment_pending", "fact_record_pending", "sent", "not_required", "send_failed"
  ]);
  const status = statuses.has(item.status as MessageProcessingRequirementStatus)
    ? item.status as MessageProcessingRequirementStatus
    : "pending_dispatch";
  return {
    ...item,
    id: String(item.id),
    dedupeKey: String(item.dedupeKey),
    kind,
    replyPolicy,
    status,
    source,
    factAssessmentRequired: item.factAssessmentRequired === true,
    projectFactAssessment: normalizeProjectFactAssessment(item.projectFactAssessment),
    knowledgeMatches: normalizeKnowledgeMatches(item.knowledgeMatches),
    knowledgeMatchDispositions: normalizeKnowledgeMatchDispositions(item.knowledgeMatchDispositions),
    knowledgeCallbacks: normalizeKnowledgeCallbacks(item.knowledgeCallbacks),
    knowledgeCallbackDueAt: cleanText(item.knowledgeCallbackDueAt, 100),
    lastKnowledgeReminderAt: cleanText(item.lastKnowledgeReminderAt, 100),
    criticalFacts: normalizeCriticalFacts(item.criticalFacts),
    criticalFactDisposition: normalizeCriticalFactDisposition(item.criticalFactDisposition),
    worker: normalizedWorker(item.worker),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    dueAt: String(item.dueAt),
    messageGroupId: cleanText(item.messageGroupId, 200),
    lastError: cleanText(item.lastError, 4_000)
  } as MessageProcessingRequirement;
}

function normalizePlanOrigin(value: unknown): MessageProcessingPlanOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<MessageProcessingPlanOrigin>;
  const source = normalizeSource(item.source);
  const roleId = cleanText(item.roleId, 200);
  const planId = cleanText(item.planId, 300);
  const sourceRequirementId = cleanText(item.sourceRequirementId, 300);
  if (!roleId || !planId || !sourceRequirementId || !source) return undefined;
  return {
    key: `${roleId}:${planId}:${sourceRequirementId}`,
    roleId,
    planId,
    planTitle: cleanText(item.planTitle, 500),
    sourceRequirementId,
    source,
    worker: normalizedWorker(item.worker),
    lastObservedPlanUpdatedAt: cleanText(item.lastObservedPlanUpdatedAt, 100),
    lastPlan: item.lastPlan && typeof item.lastPlan === "object" && !Array.isArray(item.lastPlan)
      ? item.lastPlan as MessageProcessingPlanSnapshot
      : undefined,
    linkedAt: cleanText(item.linkedAt, 100) || new Date(0).toISOString()
  };
}

function normalizeState(value: unknown): MessageProcessingBoardState {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<MessageProcessingBoardState>
    : {};
  return {
    schemaVersion: MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION,
    updatedAt: cleanText(parsed.updatedAt, 100) || new Date(0).toISOString(),
    requirements: Array.isArray(parsed.requirements)
      ? parsed.requirements.flatMap((item) => normalizeRequirement(item) ?? [])
      : [],
    planOrigins: Array.isArray(parsed.planOrigins)
      ? parsed.planOrigins.flatMap((item) => normalizePlanOrigin(item) ?? [])
      : [],
    dedupeRecords: Array.isArray(parsed.dedupeRecords)
      ? parsed.dedupeRecords.flatMap((item) => normalizeDedupeRecord(item) ?? [])
      : []
  };
}

function requiresBoardStateMigration(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<MessageProcessingBoardState>;
  return state.schemaVersion !== MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION || !Array.isArray(state.dedupeRecords);
}

function planStepsSignature(plan: PlanItem): string {
  return JSON.stringify(plan.steps.map((step) => ({
    id: step.id,
    status: step.status,
    waitingFor: step.waitingFor,
    completedAt: step.completedAt,
    blockedBy: step.blockedBy
  })));
}

function planSnapshot(plan: PlanItem): MessageProcessingPlanSnapshot {
  return {
    updatedAt: plan.updatedAt,
    status: plan.status,
    currentStep: plan.currentStep,
    currentStepId: plan.currentStepId,
    nextAction: plan.nextAction,
    waitingFor: plan.waitingFor,
    isBlocked: plan.isBlocked,
    blockedBy: plan.blockedBy,
    stepsSignature: planStepsSignature(plan)
  };
}

function describePlanSnapshotChanges(before: MessageProcessingPlanSnapshot, after: PlanItem): string[] {
  const changes: string[] = [];
  if (before.status !== after.status) changes.push(`状态：${before.status} → ${after.status}`);
  if (before.currentStepId !== after.currentStepId || before.currentStep !== after.currentStep) {
    changes.push(`当前步骤：${before.currentStep || before.currentStepId || "未设置"} → ${after.currentStep || after.currentStepId || "未设置"}`);
  }
  if (before.nextAction !== after.nextAction) changes.push(`下一步：${before.nextAction || "未设置"} → ${after.nextAction || "未设置"}`);
  if (before.waitingFor !== after.waitingFor) changes.push(`等待对象：${before.waitingFor || "无"} → ${after.waitingFor || "无"}`);
  if (before.isBlocked !== after.isBlocked || before.blockedBy !== after.blockedBy) {
    changes.push(`阻塞：${before.blockedBy || (before.isBlocked ? "是" : "否")} → ${after.blockedBy || (after.isBlocked ? "是" : "否")}`);
  }
  if (before.stepsSignature !== planStepsSignature(after)) changes.push("计划步骤进展已变化");
  return changes;
}

export function describePlanCommunicationChanges(before: PlanItem, after: PlanItem): string[] {
  const changes: string[] = [];
  if (before.status !== after.status) changes.push(`状态：${before.status} → ${after.status}`);
  if (before.currentStepId !== after.currentStepId || before.currentStep !== after.currentStep) {
    changes.push(`当前步骤：${before.currentStep || before.currentStepId || "未设置"} → ${after.currentStep || after.currentStepId || "未设置"}`);
  }
  if (before.nextAction !== after.nextAction) changes.push(`下一步：${before.nextAction || "未设置"} → ${after.nextAction || "未设置"}`);
  if (before.waitingFor !== after.waitingFor) changes.push(`等待对象：${before.waitingFor || "无"} → ${after.waitingFor || "无"}`);
  if (before.isBlocked !== after.isBlocked || before.blockedBy !== after.blockedBy) {
    changes.push(`阻塞：${before.blockedBy || (before.isBlocked ? "是" : "否")} → ${after.blockedBy || (after.isBlocked ? "是" : "否")}`);
  }
  if (planStepsSignature(before) !== planStepsSignature(after)) changes.push("计划步骤进展已变化");
  return changes;
}

export class MessageProcessingBoardStore {
  private readonly requirements = new Map<string, MessageProcessingRequirement>();
  private readonly planOrigins = new Map<string, MessageProcessingPlanOrigin>();
  private readonly dedupeRecords = new Map<string, MessageProcessingDedupeRecord>();
  private readonly persistence: MessageProcessingBoardPersistence;

  constructor(
    persistence: string | MessageProcessingBoardPersistence,
    private readonly now: () => Date = () => new Date()
  ) {
    this.persistence = typeof persistence === "string"
      ? new JsonFileMessageProcessingBoardPersistence(persistence)
      : persistence;
    const rawState = this.persistence.read();
    const state = normalizeState(rawState);
    let migratedRequirementKeys = false;
    for (const requirement of state.requirements) {
      if (requirement.kind === "message_reply") {
        const dedupeKey = messageSourceDedupeKey(requirement.source);
        migratedRequirementKeys ||= requirement.dedupeKey !== dedupeKey;
        requirement.dedupeKey = dedupeKey;
      }
      this.requirements.set(requirement.id, requirement);
    }
    for (const origin of state.planOrigins) this.planOrigins.set(origin.key, origin);
    for (const record of state.dedupeRecords) this.dedupeRecords.set(record.key, record);
    const pruned = this.pruneExpiredState();
    if (requiresBoardStateMigration(rawState) || migratedRequirementKeys || pruned.requirements || pruned.planOrigins) this.persist();
  }

  getRequirement(requirementId: string): MessageProcessingRequirement | undefined {
    const requirement = this.requirements.get(requirementId);
    return requirement ? structuredClone(requirement) : undefined;
  }

  pruneExpired(): MessageProcessingBoardPruneResult {
    const pruned = this.pruneExpiredState();
    if (pruned.requirements || pruned.planOrigins) this.persist();
    return pruned;
  }

  registerMessageGroup(input: RegisterMessageGroupRequirementInput): MessageProcessingGroupRegistrationResult {
    const existing = this.requirements.get(input.requirementId);
    if (existing) return { outcome: "existing", requirement: structuredClone(existing) };
    const source = normalizeSource(input.source);
    if (!source) throw new Error("Invalid message-processing source.");
    if (!String(input.messageGroupId || "").trim()) throw new Error("Missing messageGroupId.");
    const dedupeKey = messageSourceDedupeKey(source);
    const duplicate = [...this.requirements.values()].find((requirement) =>
      requirement.kind === "message_reply" && requirement.dedupeKey === dedupeKey
    );
    if (duplicate) return { outcome: "existing", requirement: structuredClone(duplicate) };
    const replayRecord = this.dedupeRecords.get(dedupeKey);
    if (replayRecord && Date.parse(replayRecord.expiresAt) > this.now().getTime()) {
      return { outcome: "replay_suppressed", dedupeKey };
    }
    const createdAt = nowIso(this.now);
    const replyPolicy = messageReplyPolicy(source);
    const knowledgeMatches = normalizeKnowledgeMatches(input.knowledgeMatches);
    const requirement: MessageProcessingRequirement = {
      id: input.requirementId,
      dedupeKey,
      kind: "message_reply",
      replyPolicy,
      status: "pending_dispatch",
      source,
      factAssessmentRequired: true,
      knowledgeMatches,
      knowledgeCallbackDueAt: knowledgeMatches.length
        ? new Date(this.now().getTime() + MESSAGE_PROCESSING_KNOWLEDGE_CALLBACK_DUE_MS).toISOString()
        : undefined,
      messageGroupId: input.messageGroupId,
      createdAt,
      updatedAt: createdAt,
      dueAt: new Date(this.now().getTime() + (replyPolicy === "required"
        ? MESSAGE_PROCESSING_REQUIRED_DUE_MS
        : MESSAGE_PROCESSING_DECISION_DUE_MS)).toISOString()
    };
    this.requirements.set(requirement.id, requirement);
    this.persist("registered", requirement.id, undefined, requirement.status);
    return { outcome: "created", requirement: structuredClone(requirement) };
  }

  recordDispatch(requirementId: string, worker: MessageProcessingWorker): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const normalized = normalizedWorker(worker);
    if (!normalized) throw new Error("Invalid message-processing worker.");
    requirement.worker = normalized;
    requirement.status = "processing";
    requirement.lastError = undefined;
    requirement.updatedAt = nowIso(this.now);
    this.persist("dispatched", requirement.id, undefined, requirement.status);
    return structuredClone(requirement);
  }

  recordWorkerReference(requirementId: string, worker: MessageProcessingWorker): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const normalized = normalizedWorker(worker);
    if (!normalized) throw new Error("Invalid message-processing worker.");
    requirement.worker = normalized;
    requirement.updatedAt = nowIso(this.now);
    this.persist("worker_reference_updated", requirement.id, requirement.status, requirement.status);
    return structuredClone(requirement);
  }

  replaceWorkerReferences(previousThreadId: string, worker: MessageProcessingWorker): {
    requirements: number;
    planOrigins: number;
  } {
    const normalized = normalizedWorker(worker);
    if (!normalized) throw new Error("Invalid message-processing worker.");
    let requirements = 0;
    let planOrigins = 0;
    const updatedAt = nowIso(this.now);
    for (const requirement of this.requirements.values()) {
      if (requirement.worker?.threadId !== previousThreadId) continue;
      requirement.worker = structuredClone(normalized);
      requirement.updatedAt = updatedAt;
      requirements += 1;
    }
    for (const origin of this.planOrigins.values()) {
      if (origin.worker?.threadId !== previousThreadId) continue;
      origin.worker = structuredClone(normalized);
      planOrigins += 1;
    }
    if (requirements || planOrigins) this.persist();
    return { requirements, planOrigins };
  }

  recordDispatchFailure(requirementId: string, error: unknown): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    requirement.status = "send_failed";
    requirement.lastError = cleanText(error instanceof Error ? error.message : error, 4_000) || "消息没有成功交给处理 Agent。";
    requirement.updatedAt = nowIso(this.now);
    this.persist("dispatch_failed", requirement.id, undefined, requirement.status);
    return structuredClone(requirement);
  }

  recordHandoffReturned(requirementId: string, returnedByThreadId?: string): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    if (!requirement.handoff) throw new Error(`Message processing requirement has no handoff: ${requirementId}`);
    const targetThreadId = cleanText(requirement.handoff.targetThreadId, 100);
    const returnedBy = cleanText(returnedByThreadId, 100);
    if (targetThreadId && returnedBy && targetThreadId !== returnedBy) {
      throw new Error("Message processing handoff result must be returned by the recorded target task.");
    }
    const updatedAt = nowIso(this.now);
    requirement.handoff.returnedAt = updatedAt;
    requirement.status = "processing";
    requirement.lastError = undefined;
    requirement.updatedAt = updatedAt;
    this.persist("handoff_returned", requirement.id, undefined, requirement.status);
    return structuredClone(requirement);
  }

  submitOutcome(requirementId: string, input: MessageProcessingOutcomeInput): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const alreadySent = requirement.status === "sent";
    if (alreadySent && !input.projectFactAssessment && !input.criticalFactDisposition) return structuredClone(requirement);
    const decidedAt = nowIso(this.now);
    const sourceEvidenceReview = validateSourceEvidenceReview(requirement, input);
    if (sourceEvidenceReview) requirement.sourceEvidenceReview = sourceEvidenceReview;
    const projectFactAssessment = validateProjectFactAssessment(requirement, input);
    if (projectFactAssessment) {
      requirement.projectFactAssessment = projectFactAssessment;
      requirement.criticalFacts = projectFactAssessment.status === "critical"
        ? projectFactAssessment.facts
        : undefined;
    }
    const knowledgeMatchDispositions = validateKnowledgeMatchDispositions(requirement, input);
    if (knowledgeMatchDispositions) requirement.knowledgeMatchDispositions = knowledgeMatchDispositions;
    const criticalFactDisposition = validateCriticalFactDisposition(requirement, input);
    if (alreadySent) {
      if (criticalFactDisposition) requirement.criticalFactDisposition = criticalFactDisposition;
      requirement.status = "sent";
      requirement.updatedAt = decidedAt;
      requirement.lastError = undefined;
      this.persist();
      return structuredClone(requirement);
    }
    if (requirement.status === "fact_assessment_pending" || requirement.status === "fact_record_pending") {
      if (!requirement.projectFactAssessment) throw new Error("The sent message still requires projectFactAssessment.");
      if (requirement.projectFactAssessment.status === "critical" && !criticalFactDisposition) {
        throw new Error("The sent message still requires a verified criticalFactDisposition.");
      }
      if (criticalFactDisposition) requirement.criticalFactDisposition = criticalFactDisposition;
      requirement.status = "sent";
      requirement.updatedAt = decidedAt;
      requirement.lastError = undefined;
      this.persist();
      return structuredClone(requirement);
    }
    if (input.decision === "no_reply") {
      const reasonCode = input.reasonCode || "agent_judgement";
      if (requirement.replyPolicy === "required" && !allowedRequiredSilenceReasons.has(reasonCode)) {
        throw new Error("This message requires a visible reply. no_reply is allowed only for closing-only, duplicate, self, already-answered, withdrawn, superseded-by-followup, or invalid-source messages.");
      }
      const reason = cleanText(input.reason, 2_000);
      if (reasonCode === "superseded_by_followup" && !reasonContainsNamedMessageReference(reason || "")) {
        throw new Error("superseded_by_followup requires a concrete follow-up messageId or sentMessageId in reason.");
      }
      if (reasonCode === "attachment_consumed") {
        if (!/^\s*(?:\[CQ:(?:image|video|file)[^\]]*\]\s*)+$/i.test(requirement.source.summary || "")) {
          throw new Error("attachment_consumed is allowed only for an attachment-only source message.");
        }
        if (!input.planId || !reasonContainsSourceMessageId(reason || "", requirement.source.messageIds)) {
          throw new Error("attachment_consumed requires planId and the source messageId in reason.");
        }
      }
      requirement.status = "not_required";
      requirement.decision = {
        type: "no_reply",
        reasonCode,
        reason,
        decidedAt,
        decidedByThreadId: cleanText(input.decidedByThreadId, 100)
      };
    } else if (input.decision === "handoff") {
      const targetAgentType = cleanText(input.targetAgentType, 80);
      if (!targetAgentType) throw new Error("handoff requires targetAgentType.");
      requirement.status = "handed_off";
      requirement.decision = {
        type: "handoff",
        reason: cleanText(input.reason, 2_000),
        decidedAt,
        decidedByThreadId: cleanText(input.decidedByThreadId, 100)
      };
      requirement.handoff = {
        targetAgentType,
        targetThreadId: cleanText(input.targetThreadId, 100),
        targetThreadName: cleanText(input.targetThreadName, 300),
        acceptedAt: decidedAt
      };
    } else {
      requirement.status = "awaiting_send";
      requirement.decision = {
        type: "reply",
        reason: cleanText(input.reason, 2_000),
        decidedAt,
        decidedByThreadId: cleanText(input.decidedByThreadId, 100)
      };
    }
    requirement.lastError = undefined;
    if (criticalFactDisposition) requirement.criticalFactDisposition = criticalFactDisposition;
    requirement.updatedAt = decidedAt;
    if (input.planId) this.linkPlan(requirement, input);
    this.persist("reply_recorded", requirement.id, undefined, requirement.status);
    return structuredClone(requirement);
  }

  recordReply(requirementId: string, result: AgentReplyResult, deliveryId?: string): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const updatedAt = nowIso(this.now);
    requirement.delivery = {
      deliveryId: cleanText(deliveryId, 300),
      status: result.status,
      sentMessageId: cleanText(result.sentMessageId, 300),
      reason: cleanText(result.reason, 2_000),
      updatedAt
    };
    requirement.status = result.status === "sent"
      ? requirement.factAssessmentRequired && !requirement.projectFactAssessment
        ? "fact_assessment_pending"
        : requirement.criticalFacts?.length && !requirement.criticalFactDisposition
          ? "fact_record_pending"
          : "sent"
      : result.status === "draft"
        ? "awaiting_approval"
        : "send_failed";
    requirement.lastError = result.status === "failed" || result.status === "blocked"
      ? cleanText(result.reason, 4_000) || `Outbox ${result.status}.`
      : undefined;
    requirement.updatedAt = updatedAt;
    this.persist("knowledge_callback_recorded", requirement.id, requirement.status, requirement.status);
    return structuredClone(requirement);
  }

  recordSend(requirementId: string, result: AgentSendResult, deliveryId?: string): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const updatedAt = nowIso(this.now);
    const endpoint = requirement.source.endpoint.trim().toLowerCase();
    const expectedChannel = endpoint === "qq"
      ? "napcat"
      : endpoint === "rolepanel"
        ? "role_panel"
        : endpoint === "planfeedback"
          ? "plan_feedback"
          : endpoint.split(":", 1)[0];
    const channelMatches = Boolean(result.channel && result.channel === expectedChannel);
    const hasChannelReceipt = result.channel !== "napcat"
      || Boolean(result.sentMessageId || result.sentFileId || result.sentFileName);
    requirement.delivery = {
      deliveryId: cleanText(deliveryId, 300),
      status: result.status,
      channel: cleanText(result.channel, 80),
      sentMessageId: cleanText(result.sentMessageId, 300),
      sentFileId: cleanText(result.sentFileId, 300),
      sentFileName: cleanText(result.sentFileName, 500),
      reason: cleanText(result.reason, 2_000),
      updatedAt
    };
    if (result.status === "sent" && (!channelMatches || !hasChannelReceipt)) {
      requirement.status = "awaiting_send";
      requirement.lastError = !channelMatches
        ? `The send reached channel ${result.channel || "unknown"}, but this requirement expects ${expectedChannel}.`
        : "NapCat reported sent without a QQ message or file receipt.";
    } else {
      requirement.status = result.status === "sent"
        ? requirement.factAssessmentRequired && !requirement.projectFactAssessment
          ? "fact_assessment_pending"
          : requirement.criticalFacts?.length && !requirement.criticalFactDisposition
            ? "fact_record_pending"
            : "sent"
        : result.status === "draft"
          ? "awaiting_approval"
          : "send_failed";
      requirement.lastError = result.status === "failed" || result.status === "blocked"
        ? cleanText(result.reason, 4_000) || `Outbox ${result.status}.`
        : undefined;
    }
    requirement.updatedAt = updatedAt;
    this.persist();
    return structuredClone(requirement);
  }

  recordKnowledgeCallback(requirementId: string, input: KnowledgeMatchCallbackInput): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    const match = (requirement.knowledgeMatches || []).find((item) => item.id === input.knowledgeId && item.type === input.knowledgeType);
    if (!match) throw new Error(`Knowledge callback does not match a recalled plan or memory: ${input.knowledgeType}:${input.knowledgeId}`);
    const callback = normalizeKnowledgeCallbacks([{ ...input, callbackAt: input.callbackAt || nowIso(this.now) }])[0];
    if (!callback) throw new Error("Invalid knowledge callback. result, responseAction, evidence, and callback identity are required.");
    if ((callback.result === "updated" || callback.result === "created") && (!callback.recordType || !callback.recordId || !callback.verifiedAt)) {
      throw new Error(`${callback.result} knowledge callback requires recordType, recordId, and verifiedAt.`);
    }
    if (callback.result === "updated") {
      const expectedType = callback.knowledgeType === "plan" ? "plan" : "memory";
      if (callback.recordType !== expectedType) throw new Error(`updated callback for ${callback.knowledgeType} requires recordType=${expectedType}.`);
    }
    if (callback.result === "created" && !callback.recordType) throw new Error("created knowledge callback requires recordType.");
    if (callback.result === "not_relevant" && callback.responseAction !== "none") {
      throw new Error("not_relevant knowledge callback must use responseAction=none.");
    }
    const callbacks = requirement.knowledgeCallbacks || [];
    const index = callbacks.findIndex((item) => item.knowledgeId === callback.knowledgeId && item.knowledgeType === callback.knowledgeType);
    if (index >= 0) callbacks[index] = callback;
    else callbacks.push(callback);
    requirement.knowledgeCallbacks = callbacks;
    requirement.updatedAt = nowIso(this.now);
    requirement.lastError = undefined;
    this.persist();
    return structuredClone(requirement);
  }

  pendingKnowledgeMatches(requirementId: string): KnowledgeRecallMatch[] {
    const requirement = this.required(requirementId);
    const callbacks = new Map((requirement.knowledgeCallbacks || []).map((item) => [`${item.knowledgeType}:${item.knowledgeId}`, item]));
    return (requirement.knowledgeMatches || [])
      .filter((item) => !callbackIsFinal(callbacks.get(`${item.type}:${item.id}`)))
      .map((item) => structuredClone(item));
  }

  recordKnowledgeReminder(requirementId: string): MessageProcessingRequirement {
    const requirement = this.required(requirementId);
    requirement.lastKnowledgeReminderAt = nowIso(this.now);
    requirement.knowledgeCallbackDueAt = new Date(this.now().getTime() + MESSAGE_PROCESSING_KNOWLEDGE_CALLBACK_DUE_MS).toISOString();
    requirement.updatedAt = requirement.lastKnowledgeReminderAt;
    this.persist();
    return structuredClone(requirement);
  }

  registerPlanChange(roleId: string, before: PlanItem, after: PlanItem): MessageProcessingRequirement | undefined {
    const origin = [...this.planOrigins.values()]
      .filter((item) => item.roleId === roleId && item.planId === after.id)
      .sort((left, right) => Date.parse(right.linkedAt) - Date.parse(left.linkedAt))[0];
    if (!origin) return undefined;
    const changes = describePlanCommunicationChanges(before, after);
    origin.lastObservedPlanUpdatedAt = after.updatedAt;
    origin.lastPlan = planSnapshot(after);
    origin.planTitle = after.title;
    if (changes.length === 0) {
      this.persist();
      return undefined;
    }
    const dedupeKey = `plan-progress:${origin.key}:${after.updatedAt}`;
    const existing = [...this.requirements.values()].find((item) => item.dedupeKey === dedupeKey);
    if (existing) return structuredClone(existing);
    const createdAt = nowIso(this.now);
    const requirement: MessageProcessingRequirement = {
      id: `message-requirement-${randomUUID()}`,
      dedupeKey,
      kind: "plan_progress_notification",
      replyPolicy: "required",
      status: "pending_dispatch",
      source: structuredClone(origin.source),
      plan: {
        planId: after.id,
        planTitle: after.title,
        beforeUpdatedAt: before.updatedAt,
        afterUpdatedAt: after.updatedAt,
        changes
      },
      worker: origin.worker ? structuredClone(origin.worker) : undefined,
      createdAt,
      updatedAt: createdAt,
      dueAt: new Date(this.now().getTime() + MESSAGE_PROCESSING_REQUIRED_DUE_MS).toISOString()
    };
    this.requirements.set(requirement.id, requirement);
    this.persist();
    return structuredClone(requirement);
  }

  setPlanBaseline(roleId: string, plan: PlanItem): void {
    const origins = [...this.planOrigins.values()].filter((item) => item.roleId === roleId && item.planId === plan.id);
    if (origins.length === 0) return;
    for (const origin of origins) {
      origin.planTitle = plan.title;
      origin.lastObservedPlanUpdatedAt = plan.updatedAt;
      origin.lastPlan = planSnapshot(plan);
    }
    this.persist();
  }

  reconcilePlan(originKey: string, plan: PlanItem): MessageProcessingRequirement | undefined {
    const origin = this.planOrigins.get(originKey);
    if (!origin || origin.lastObservedPlanUpdatedAt === plan.updatedAt) return undefined;
    const beforeUpdatedAt = origin.lastObservedPlanUpdatedAt;
    const changes = origin.lastPlan
      ? describePlanSnapshotChanges(origin.lastPlan, plan)
      : [`计划已更新：${beforeUpdatedAt || "未知时间"} → ${plan.updatedAt}`];
    origin.lastObservedPlanUpdatedAt = plan.updatedAt;
    origin.lastPlan = planSnapshot(plan);
    origin.planTitle = plan.title;
    if (changes.length === 0) {
      this.persist();
      return undefined;
    }
    const dedupeKey = `plan-progress:${origin.key}:${plan.updatedAt}`;
    const existing = [...this.requirements.values()].find((item) => item.dedupeKey === dedupeKey);
    if (existing) return structuredClone(existing);
    const createdAt = nowIso(this.now);
    const requirement: MessageProcessingRequirement = {
      id: `message-requirement-${randomUUID()}`,
      dedupeKey,
      kind: "plan_progress_notification",
      replyPolicy: "required",
      status: "pending_dispatch",
      source: structuredClone(origin.source),
      plan: {
        planId: plan.id,
        planTitle: plan.title,
        beforeUpdatedAt,
        afterUpdatedAt: plan.updatedAt,
        changes
      },
      worker: origin.worker ? structuredClone(origin.worker) : undefined,
      createdAt,
      updatedAt: createdAt,
      dueAt: new Date(this.now().getTime() + MESSAGE_PROCESSING_REQUIRED_DUE_MS).toISOString()
    };
    this.requirements.set(requirement.id, requirement);
    this.persist();
    return structuredClone(requirement);
  }

  planOriginList(): MessageProcessingPlanOrigin[] {
    return [...this.planOrigins.values()].map((item) => structuredClone(item));
  }

  get(requirementId: string): MessageProcessingRequirement | undefined {
    const value = this.requirements.get(requirementId);
    return value ? structuredClone(value) : undefined;
  }

  findLatestBySourceMessage(routeId: string, messageId: string): MessageProcessingRequirement | undefined {
    return this.findBySourceMessage(routeId, messageId)[0];
  }

  findBySourceMessage(routeId: string, messageId: string): MessageProcessingRequirement[] {
    const normalizedRouteId = String(routeId || "").trim();
    const normalizedMessageId = String(messageId || "").trim();
    if (!normalizedRouteId || !normalizedMessageId) return [];
    return [...this.requirements.values()]
      .filter((item) =>
        (item.source.routeId === normalizedRouteId || item.source.routeProfileId === normalizedRouteId)
        && item.source.messageIds.includes(normalizedMessageId))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((item) => structuredClone(item));
  }

  list(options: { routeId?: string; limit?: number } = {}): MessageProcessingRequirement[] {
    return this.selectRequirements(options)
      .map((item) => structuredClone(item));
  }

  private selectRequirements(options: { routeId?: string; limit?: number }): MessageProcessingRequirement[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
    return [...this.requirements.values()]
      .filter((item) => !options.routeId || item.source.routeId === options.routeId || item.source.routeProfileId === options.routeId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  boardSummary(
    options: { routeId?: string; limit?: number } = {},
    workerRuntime: ReadonlyMap<string, MessageProcessingWorkerRuntimeObservation> = new Map()
  ): Record<string, unknown> {
    const requirements = this.selectRequirements(options).map((item) => ({
      id: item.id,
      kind: item.kind,
      replyPolicy: item.replyPolicy,
      status: item.status,
      source: {
        routeId: item.source.routeId,
        routeProfileId: item.source.routeProfileId,
        roleId: item.source.roleId,
        endpoint: item.source.endpoint,
        conversationKey: item.source.conversationKey,
        sender: item.source.sender,
        routeKinds: [...item.source.routeKinds],
        messageIds: [...item.source.messageIds],
        summary: item.source.summary
      },
      messageGroupId: item.messageGroupId,
      plan: item.plan ? structuredClone(item.plan) : undefined,
      worker: item.worker ? structuredClone(item.worker) : undefined,
      decision: item.decision ? structuredClone(item.decision) : undefined,
      handoff: item.handoff ? structuredClone(item.handoff) : undefined,
      delivery: item.delivery ? structuredClone(item.delivery) : undefined,
      factAssessmentRequired: item.factAssessmentRequired,
      projectFactAssessed: Boolean(item.projectFactAssessment),
      knowledgeMatches: item.knowledgeMatches ? structuredClone(item.knowledgeMatches) : undefined,
      knowledgeCallbacks: item.knowledgeCallbacks ? structuredClone(item.knowledgeCallbacks) : undefined,
      knowledgeCallbackDueAt: item.knowledgeCallbackDueAt,
      criticalFacts: item.criticalFacts ? structuredClone(item.criticalFacts) : undefined,
      criticalFactDisposition: item.criticalFactDisposition ? structuredClone(item.criticalFactDisposition) : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      dueAt: item.dueAt,
      lastError: item.lastError
    }));
    const now = this.now().getTime();
    const terminal = new Set<MessageProcessingRequirementStatus>(["sent", "not_required"]);
    const items = requirements.map((item) => {
      const overdueMs = terminal.has(item.status) ? 0 : Math.max(0, now - Date.parse(item.dueAt));
      const observation = item.worker ? workerRuntime.get(item.worker.threadId) : undefined;
      const worker = item.worker
        ? {
            ...item.worker,
            ...(observation?.threadName ? { threadName: observation.threadName } : {}),
            ...(observation?.workspace ? { workspace: observation.workspace } : {}),
            ...(observation ? {
              runtimeStatus: observation.status,
              active: observation.status === "active" ? true : observation.status === "idle" ? false : undefined,
              observedAt: observation.observedAt
            } : {})
          }
        : undefined;
      return {
        ...item,
        worker,
        overdueMs,
        missingOutcome: item.status === "processing" && observation?.status === "idle"
      };
    });
    return {
      updatedAt: nowIso(this.now),
      counts: {
        total: items.length,
        requiredOpen: items.filter((item) => item.replyPolicy === "required" && !terminal.has(item.status)).length,
        agentDecisionOpen: items.filter((item) => item.replyPolicy === "agent_decides" && !terminal.has(item.status)).length,
        handedOff: items.filter((item) => item.status === "handed_off").length,
        overdue: items.filter((item) => item.overdueMs > 0).length,
        sendFailed: items.filter((item) => item.status === "send_failed").length,
        missingOutcome: items.filter((item) => item.missingOutcome).length,
        factAssessmentOpen: items.filter((item) => item.factAssessmentRequired && !item.projectFactAssessed).length,
        knowledgeCallbackOpen: items.filter((item) => {
          const callbacks = new Map((item.knowledgeCallbacks || []).map((callback) => [`${callback.knowledgeType}:${callback.knowledgeId}`, callback]));
          return (item.knowledgeMatches || []).some((match) => !callbackIsFinal(callbacks.get(`${match.type}:${match.id}`)));
        }).length,
        criticalFactOpen: items.filter((item) => item.criticalFacts?.length && !item.criticalFactDisposition).length,
        sent24h: items.filter((item) => item.status === "sent" && now - Date.parse(item.updatedAt) <= 24 * 60 * 60 * 1_000).length
      },
      items
    };
  }

  board(
    options: { routeId?: string; limit?: number } = {},
    workerRuntime: ReadonlyMap<string, MessageProcessingWorkerRuntimeObservation> = new Map()
  ): Record<string, unknown> {
    const requirements = this.list(options);
    const now = this.now().getTime();
    const terminal = new Set<MessageProcessingRequirementStatus>(["sent", "not_required"]);
    const items = requirements.map((item) => {
      const overdueMs = terminal.has(item.status) ? 0 : Math.max(0, now - Date.parse(item.dueAt));
      const observation = item.worker ? workerRuntime.get(item.worker.threadId) : undefined;
      const worker = item.worker
        ? {
            ...item.worker,
            ...(observation?.threadName ? { threadName: observation.threadName } : {}),
            ...(observation?.workspace ? { workspace: observation.workspace } : {}),
            ...(observation ? {
              runtimeStatus: observation.status,
              active: observation.status === "active" ? true : observation.status === "idle" ? false : undefined,
              observedAt: observation.observedAt
            } : {})
          }
        : undefined;
      const missingOutcome = item.status === "processing" && observation?.status === "idle";
      return { ...item, worker, overdueMs, missingOutcome };
    });
    return {
      updatedAt: nowIso(this.now),
      counts: {
        total: items.length,
        requiredOpen: items.filter((item) => item.replyPolicy === "required" && !terminal.has(item.status)).length,
        agentDecisionOpen: items.filter((item) => item.replyPolicy === "agent_decides" && !terminal.has(item.status)).length,
        handedOff: items.filter((item) => item.status === "handed_off").length,
        overdue: items.filter((item) => item.overdueMs > 0).length,
        sendFailed: items.filter((item) => item.status === "send_failed").length,
        missingOutcome: items.filter((item) => item.missingOutcome).length,
        factAssessmentOpen: items.filter((item) => item.factAssessmentRequired && !item.projectFactAssessment).length,
        knowledgeCallbackOpen: items.filter((item) => {
          const callbacks = new Map((item.knowledgeCallbacks || []).map((callback) => [`${callback.knowledgeType}:${callback.knowledgeId}`, callback]));
          return (item.knowledgeMatches || []).some((match) => !callbackIsFinal(callbacks.get(`${match.type}:${match.id}`)));
        }).length,
        criticalFactOpen: items.filter((item) => item.criticalFacts?.length && !item.criticalFactDisposition).length,
        sent24h: items.filter((item) => item.status === "sent" && now - Date.parse(item.updatedAt) <= 24 * 60 * 60 * 1_000).length
      },
      items
    };
  }

  snapshot(): MessageProcessingBoardState {
    return {
      schemaVersion: MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION,
      updatedAt: nowIso(this.now),
      requirements: [...this.requirements.values()].map((item) => structuredClone(item)),
      planOrigins: [...this.planOrigins.values()].map((item) => structuredClone(item)),
      dedupeRecords: [...this.dedupeRecords.values()].map((item) => structuredClone(item))
    };
  }

  private linkPlan(requirement: MessageProcessingRequirement, input: MessageProcessingOutcomeInput): void {
    const roleId = cleanText(input.roleId, 200) || requirement.source.roleId;
    const planId = cleanText(input.planId, 300);
    if (!roleId || !planId) throw new Error("Linking a plan to a message requires roleId and planId.");
    const key = `${roleId}:${planId}:${requirement.id}`;
    this.planOrigins.set(key, {
      key,
      roleId,
      planId,
      planTitle: cleanText(input.planTitle, 500),
      sourceRequirementId: requirement.id,
      source: structuredClone(requirement.source),
      worker: requirement.worker ? structuredClone(requirement.worker) : undefined,
      linkedAt: nowIso(this.now)
    });
  }

  private required(requirementId: string): MessageProcessingRequirement {
    const requirement = this.requirements.get(requirementId);
    if (!requirement) throw new Error(`Message processing requirement not found: ${requirementId}`);
    return requirement;
  }

  private persist(
    action = "state_updated",
    targetId = "board",
    beforeStatus?: MessageProcessingRequirementStatus,
    afterStatus?: MessageProcessingRequirementStatus
  ): void {
    this.pruneExpiredState();
    const updatedAt = nowIso(this.now);
    try {
      this.persistence.write({
      schemaVersion: MESSAGE_PROCESSING_BOARD_SCHEMA_VERSION,
      updatedAt,
      requirements: [...this.requirements.values()],
      planOrigins: [...this.planOrigins.values()],
      dedupeRecords: [...this.dedupeRecords.values()]
      } satisfies MessageProcessingBoardState);
      recordDataMutationAudit({
        group: "message.processing",
        event: `message_processing_${action}`,
        owner: "MessageProcessingBoardStore",
        action,
        target: { type: targetId === "board" ? "message_processing_board" : "message_processing_requirement", id: targetId },
        dataSource: { kind: "runtime", id: "message-processing-board" },
        outcome: "queued",
        after: { revision: updatedAt },
        changes: beforeStatus !== afterStatus
          ? [{ field: "status", from: beforeStatus, to: afterStatus }]
          : undefined
      });
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "message.processing",
        event: `message_processing_${action}_failed`,
        owner: "MessageProcessingBoardStore",
        action,
        target: { type: targetId === "board" ? "message_processing_board" : "message_processing_requirement", id: targetId },
        dataSource: { kind: "runtime", id: "message-processing-board" },
        outcome: "failed",
        error
      });
      throw error;
    }
  }

  private retainDedupeKey(dedupeKey: string, createdAt: string, now: number): void {
    if (!/^[a-f0-9]{64}$/i.test(dedupeKey)) return;
    const createdAtMs = Date.parse(createdAt);
    const baseTime = Number.isNaN(createdAtMs) ? now : createdAtMs;
    const expiresAt = new Date(baseTime + MESSAGE_PROCESSING_DEDUPE_RETENTION_MS).toISOString();
    if (Date.parse(expiresAt) <= now) return;
    const existing = this.dedupeRecords.get(dedupeKey);
    if (!existing || Date.parse(existing.expiresAt) < Date.parse(expiresAt)) {
      this.dedupeRecords.set(dedupeKey, { key: dedupeKey, expiresAt });
    }
  }

  private pruneExpiredState(): MessageProcessingBoardPruneResult {
    const now = this.now().getTime();
    for (const [key, record] of this.dedupeRecords) {
      if (Date.parse(record.expiresAt) > now) continue;
      this.dedupeRecords.delete(key);
    }

    let planOrigins = 0;
    for (const [key, origin] of this.planOrigins) {
      if (now - Date.parse(origin.linkedAt) < MESSAGE_PROCESSING_PLAN_ORIGIN_RETENTION_MS) continue;
      this.planOrigins.delete(key);
      planOrigins += 1;
    }

    let requirements = 0;
    for (const [id, requirement] of this.requirements) {
      if (now - Date.parse(requirement.createdAt) < requirementRetentionMs(requirement)) continue;
      if (requirement.kind === "message_reply") this.retainDedupeKey(requirement.dedupeKey, requirement.createdAt, now);
      this.requirements.delete(id);
      requirements += 1;
    }
    return { requirements, planOrigins };
  }
}
