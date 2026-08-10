import type { IdentityRelationContext } from "../identityRelations.js";
import type { ForwardRecord, ForwardRouteKind } from "./types.js";

export type ConversationProjectCandidate = {
  projectId: string;
  status: "candidate" | "confirmed";
  relationship: string;
};

export type ConversationSituationInput = {
  conversationId?: string;
  messageIds?: string[];
  routeKind?: ForwardRouteKind;
};

export type ConversationSituation = {
  conversationId?: string;
  messageIds: string[];
  speaker: {
    stableId?: string;
    confirmedParticipantId?: string;
    candidateParticipantIds: string[];
  };
  addressing: {
    target: "group" | "private" | "system" | "unknown";
    addressesAgent: boolean;
    replyToMessageId?: string;
  };
  topic: {
    kind: "project_discussion" | "unknown";
    projectCandidates: ConversationProjectCandidate[];
  };
  intent: "open_question" | "statement" | "unknown";
  agentPosition: "informed_peer" | "observer";
  evidence: {
    attachmentState: "not_applicable" | "unreviewed";
    unresolved: string[];
  };
  decisions: {
    mayParticipate: true;
    mayCreateOrUpdateCurrentProjectRecords: false;
    reason: string;
  };
};

/**
 * This deliberately produces a conservative, explainable situation card.
 * It may surface a project relation already scoped to this conversation, but
 * never treats the Route, workspace, display name, or message wording as
 * evidence that Xinghai owns the project or has authority to manage it.
 */
export function conversationSituationForIdentity(
  identity: IdentityRelationContext | undefined,
  input: ConversationSituationInput = {}
): ConversationSituation {
  const candidates = new Map<string, ConversationProjectCandidate>();
  for (const relation of identity?.relevantRelations ?? []) {
    if (relation.targetKind !== "project") continue;
    const status = relation.status === "confirmed" ? "confirmed" : "candidate";
    const previous = candidates.get(relation.targetId);
    if (!previous || (previous.status === "candidate" && status === "confirmed")) {
      candidates.set(relation.targetId, {
        projectId: relation.targetId,
        status,
        relationship: relation.relationship
      });
    }
  }
  const projectCandidates = [...candidates.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  const routeKind = input.routeKind;
  const target = routeKind === "private" || routeKind === "weixin_message"
    ? "private"
    : routeKind === "group_message" || routeKind === "direct_at" || routeKind === "direct_reply" || routeKind === "indirect_reply" || routeKind === "wecom_message" || routeKind === "feishu_message"
      ? "group"
      : routeKind === "heartbeat" || routeKind === "manual_trigger" || routeKind === "plan_feedback" || routeKind === "role_panel_message"
        ? "system"
        : "unknown";
  return {
    conversationId: input.conversationId,
    messageIds: [...new Set(input.messageIds ?? [])],
    speaker: {
      stableId: identity?.endpoint.senderStableId,
      confirmedParticipantId: identity?.confirmedParticipant?.id,
      candidateParticipantIds: identity?.candidateParticipants.map(item => item.participant.id) ?? []
    },
    addressing: {
      target,
      addressesAgent: routeKind === "direct_at" || routeKind === "direct_reply",
      replyToMessageId: undefined
    },
    topic: {
      kind: projectCandidates.length > 0 ? "project_discussion" : "unknown",
      projectCandidates
    },
    intent: "unknown",
    agentPosition: projectCandidates.length > 0 ? "informed_peer" : "observer",
    evidence: {
      attachmentState: "not_applicable",
      unresolved: [...(identity?.unresolved ?? [])]
    },
    decisions: {
      mayParticipate: true,
      mayCreateOrUpdateCurrentProjectRecords: false,
      reason: "身份关系和当前对话范围只能提供讨论线索；没有单独的项目范围、明确请求与授权，不能据此管理项目记录。"
    }
  };
}

export function conversationSituationLines(situation: ConversationSituation): string[] {
  const topic = situation.topic.kind === "project_discussion"
    ? "当前对话可关联的项目讨论（仅作线索）："
    : "当前对话尚未得到可核对的项目线索。";
  const projects = situation.topic.projectCandidates.map(item =>
    `- ${item.status === "confirmed" ? "已确认" : "候选"}项目关系：${item.projectId}（${item.relationship}）`
  );
  return [
    topic,
    ...projects,
    "可以自然参与有价值的讨论、澄清问题或提出建议。",
    situation.decisions.reason,
    "除非另有明确项目范围、请求和授权，不得据此查询、创建、更新或转交任何项目计划、任务或长期项目记忆。"
  ];
}

function recordText(record: ForwardRecord, key: string): string | undefined {
  const value = key in record ? (record as unknown as Record<string, unknown>)[key] : undefined;
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function attachmentState(record: ForwardRecord): "not_applicable" | "unreviewed" {
  const attachments = "attachments" in record ? (record as unknown as Record<string, unknown>).attachments : undefined;
  return Array.isArray(attachments) && attachments.length > 0 ? "unreviewed" : "not_applicable";
}

/** Adds only transport facts that can be reconstructed from the delivered record. */
export function conversationSituationForDelivery(
  identity: IdentityRelationContext | undefined,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: Omit<ConversationSituationInput, "routeKind"> = {}
): ConversationSituation {
  const rawMessage = String(record.rawMessage || "").trim();
  const replyToMessageId = recordText(record, "replyToMessageId") ?? recordText(record, "replyMessageId");
  const situation = conversationSituationForIdentity(identity, { ...options, routeKind });
  return {
    ...situation,
    speaker: { ...situation.speaker, stableId: situation.speaker.stableId ?? recordText(record, "senderId") ?? recordText(record, "userId") },
    addressing: { ...situation.addressing, replyToMessageId },
    intent: rawMessage ? (/[?？]\s*$/.test(rawMessage) ? "open_question" : "statement") : "unknown",
    evidence: {
      attachmentState: attachmentState(record),
      unresolved: [
        ...situation.evidence.unresolved,
        ...(attachmentState(record) === "unreviewed" ? ["当前消息带有未读回的附件；不得把附件内容当作已知事实。"] : [])
      ]
    }
  };
}
