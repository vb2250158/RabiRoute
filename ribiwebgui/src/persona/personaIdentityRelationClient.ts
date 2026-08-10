export type IdentityRelationStatus = "candidate" | "confirmed" | "corrected" | "retired";
export type IdentityParticipantKind = "person" | "organization" | "shared_account" | "automated" | "unknown";
export type IdentityRelationTargetKind = "participant" | "organization" | "project";

export type IdentityEvidenceRef = {
  gatewayId?: string;
  routeId?: string;
  endpoint?: string;
  conversationKey?: string;
  messageId?: string;
  note?: string;
};

export type IdentityParticipantLink = {
  participantId: string;
  status: IdentityRelationStatus;
  confidence?: number;
  evidenceRefs: IdentityEvidenceRef[];
};

export type IdentityRelationConflictCandidate = {
  eventId: string;
  record: IdentityEndpointAccount | IdentityParticipant | IdentityRelationCard;
};

type ConflictState = {
  conflicted?: boolean;
  conflictEventIds?: string[];
  conflictCandidates?: IdentityRelationConflictCandidate[];
};

export type IdentityEndpointAccount = ConflictState & {
  id: string;
  platform: string;
  endpointIdentityNamespace: string;
  senderStableId: string;
  displayName?: string;
  isSelf?: boolean;
  participantLinks: IdentityParticipantLink[];
  updatedAt: string;
};

export type IdentityParticipant = ConflictState & {
  id: string;
  kind: IdentityParticipantKind;
  displayName?: string;
  aliases: string[];
  status: IdentityRelationStatus;
  evidenceRefs: IdentityEvidenceRef[];
  updatedAt: string;
};

export type IdentityRelationCard = ConflictState & {
  id: string;
  subjectParticipantId: string;
  targetKind: IdentityRelationTargetKind;
  targetId: string;
  relationship: string;
  status: IdentityRelationStatus;
  scope: { conversationKeys: string[]; projectIds: string[] };
  evidenceRefs: IdentityEvidenceRef[];
  updatedAt: string;
};

export type IdentityRelationPatch = {
  kind: "endpoint_account" | "participant" | "relation_card";
  platform?: string;
  endpointIdentityNamespace?: string;
  senderStableId?: string;
  displayName?: string;
  isSelf?: boolean;
  participantLinks?: IdentityParticipantLink[];
  participantId?: string;
  participantKind?: IdentityParticipantKind;
  aliases?: string[];
  relationId?: string;
  subjectParticipantId?: string;
  targetKind?: IdentityRelationTargetKind;
  targetId?: string;
  relationship?: string;
  status?: IdentityRelationStatus;
  scope?: { conversationKeys: string[]; projectIds: string[] };
  evidenceRefs?: IdentityEvidenceRef[];
};

export type IdentityRelationListResult = {
  path: string;
  endpointAccounts: IdentityEndpointAccount[];
  participants: IdentityParticipant[];
  relationCards: IdentityRelationCard[];
};

export type ConversationSituationSnapshot = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  routeId: string;
  routeKind: string;
  conversationId?: string;
  messageIds: string[];
  speaker: { stableId?: string; confirmedParticipantId?: string; candidateParticipantIds: string[] };
  addressing: { target: "group" | "private" | "system" | "unknown"; addressesAgent: boolean; replyToMessageId?: string };
  topic: { kind: "project_discussion" | "unknown"; projectCandidates: Array<{ projectId: string; status: "candidate" | "confirmed"; relationship: string }> };
  intent: "open_question" | "statement" | "unknown";
  agentPosition: "informed_peer" | "observer";
  evidence: { attachmentState: "not_applicable" | "unreviewed"; unresolved: string[] };
  decisions: { mayParticipate: true; mayCreateOrUpdateCurrentProjectRecords: false; reason: string };
};

type ApiEnvelope<T> = { code?: number; message?: string; data?: T };

function endpoint(roleId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}/identity-relations`;
}

function situationsEndpoint(roleId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}/conversation-situations`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || body.code !== 0 || body.data == null) {
    throw new Error(body.message || `Identity relation request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

export const personaIdentityRelationClient = {
  list(roleId: string): Promise<IdentityRelationListResult> {
    return request<IdentityRelationListResult>(endpoint(roleId));
  },

  update(roleId: string, patch: IdentityRelationPatch): Promise<unknown> {
    return request(endpoint(roleId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
  },

  listSituations(roleId: string, limit = 20): Promise<ConversationSituationSnapshot[]> {
    return request<ConversationSituationSnapshot[]>(`${situationsEndpoint(roleId)}?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
  }
};
