import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";
import { withFileLockSync } from "./shared/filePersistence.js";

const MAX_TEXT = 2_000;
const MAX_LIST = 50;

/** Kept outside keyword recall and recent-memory consolidation. */
export const IDENTITY_RELATION_KNOWLEDGE_TYPE = "identity_relation" as const;
export type IdentityRelationKnowledgeType = typeof IDENTITY_RELATION_KNOWLEDGE_TYPE;
export type IdentityRelationStatus = "candidate" | "confirmed" | "corrected" | "retired";
export type IdentityParticipantKind = "person" | "organization" | "shared_account" | "automated" | "unknown";
export type IdentityRelationTargetKind = "participant" | "organization" | "project";
export type IdentitySpeakingHabitDimension =
  | "sentence_opening"
  | "sentence_length"
  | "stance_expression"
  | "emotion_threshold"
  | "analogy_source"
  | "punctuation"
  | "reader_relationship"
  | "value_preference"
  | "information_order"
  | "avoidance"
  | "imperfection"
  | "scene_boundary";

/** A corrected person or account mapping is authoritative; it is not a candidate. */
export function isAuthoritativeIdentityStatus(value: IdentityRelationStatus): boolean {
  return value === "confirmed" || value === "corrected";
}

/** Retired people and account mappings remain history and cannot drive current identity decisions. */
export function isActiveIdentityStatus(value: IdentityRelationStatus): boolean {
  return value === "candidate" || isAuthoritativeIdentityStatus(value);
}

/** A corrected relation card describes an old conclusion that was replaced, so it is not active. */
export function isActiveIdentityRelationStatus(value: IdentityRelationStatus): boolean {
  return value === "candidate" || value === "confirmed";
}

export type IdentityRelationConflictCandidate = {
  eventId: string;
  record: IdentityRelationRecord;
};

type IdentityRelationConflictState = {
  /** Multiple concurrent event heads disagree. Do not use this record for automatic identity decisions. */
  conflicted?: boolean;
  conflictEventIds?: string[];
  conflictCandidates?: IdentityRelationConflictCandidate[];
};

export type IdentityEvidenceRef = {
  gatewayId?: string;
  routeId?: string;
  endpoint?: string;
  conversationKey?: string;
  messageId?: string;
  note?: string;
};

export type IdentitySpeakingHabit = {
  dimension: IdentitySpeakingHabitDimension;
  description: string;
  confidence?: number;
  evidenceRefs: IdentityEvidenceRef[];
};

export type IdentityScope = {
  conversationKeys: string[];
  projectIds: string[];
};

export type IdentityParticipantLink = {
  participantId: string;
  status: IdentityRelationStatus;
  confidence?: number;
  evidenceRefs: IdentityEvidenceRef[];
};

export type IdentityEndpointAccount = IdentityRelationConflictState & {
  id: string;
  platform: string;
  endpointIdentityNamespace: string;
  senderStableId: string;
  displayName?: string;
  isSelf?: boolean;
  participantLinks: IdentityParticipantLink[];
  updatedAt: string;
};

export type IdentityParticipant = IdentityRelationConflictState & {
  id: string;
  kind: IdentityParticipantKind;
  displayName?: string;
  aliases: string[];
  speakingHabits?: IdentitySpeakingHabit[];
  status: IdentityRelationStatus;
  evidenceRefs: IdentityEvidenceRef[];
  updatedAt: string;
};

export type IdentityRelationCard = IdentityRelationConflictState & {
  id: string;
  subjectParticipantId: string;
  targetKind: IdentityRelationTargetKind;
  targetId: string;
  relationship: string;
  status: IdentityRelationStatus;
  scope: IdentityScope;
  evidenceRefs: IdentityEvidenceRef[];
  updatedAt: string;
};

export type IdentityRelationPatch = {
  kind: "endpoint_account" | "participant" | "relation_card";
  platform?: unknown;
  endpointIdentityNamespace?: unknown;
  senderStableId?: unknown;
  displayName?: unknown;
  isSelf?: unknown;
  participantLinks?: unknown;
  participantId?: unknown;
  participantKind?: unknown;
  aliases?: unknown;
  speakingHabits?: unknown;
  relationId?: unknown;
  subjectParticipantId?: unknown;
  targetKind?: unknown;
  targetId?: unknown;
  relationship?: unknown;
  status?: unknown;
  scope?: unknown;
  evidenceRefs?: unknown;
};

export type IdentityRelationContext = {
  endpoint: Pick<IdentityEndpointAccount, "id" | "platform" | "endpointIdentityNamespace" | "senderStableId" | "displayName" | "isSelf">;
  confirmedParticipant?: IdentityParticipant;
  /** Known people who may use this account, without claiming that the current message is uniquely theirs. */
  possibleParticipants: Array<{ participant: IdentityParticipant; link: IdentityParticipantLink }>;
  candidateParticipants: Array<{ participant: IdentityParticipant; link: IdentityParticipantLink }>;
  relevantRelations: IdentityRelationCard[];
  unresolved: string[];
};

export type IdentityEndpointLookup = {
  platform: string;
  endpointIdentityNamespace: string;
  senderStableId: string;
  displayName?: string;
  conversationKey?: string;
  projectId?: string;
};

export type IdentityCandidateRelationObservation = {
  targetKind: IdentityRelationTargetKind;
  targetId: string;
  relationship: string;
  scope?: Partial<IdentityScope>;
  evidenceRefs?: IdentityEvidenceRef[];
};

export type IdentityCandidateObservation = IdentityEndpointLookup & {
  participantId?: string;
  participantKind?: IdentityParticipantKind;
  participantDisplayName?: string;
  aliases?: string[];
  evidenceRefs?: IdentityEvidenceRef[];
  relations?: IdentityCandidateRelationObservation[];
};

export type IdentityEndpointObservationResult = {
  context?: IdentityRelationContext;
  participantId?: string;
  accountCreated: boolean;
  participantCreated: boolean;
  updated: boolean;
};

export type IdentityRelationConflict = {
  recordKind: IdentityRelationPatch["kind"];
  recordId: string;
  candidateEventIds: string[];
};

export type IdentityRelationRecord = IdentityEndpointAccount | IdentityParticipant | IdentityRelationCard;
type IdentityRelationEvent = {
  schemaVersion: 1;
  knowledgeType: IdentityRelationKnowledgeType;
  id: string;
  recordKind: IdentityRelationPatch["kind"];
  record: IdentityRelationRecord;
  createdAt: string;
  /** All event heads replaced by this deliberate update. */
  supersedes?: string[];
};

type IdentityRecordState<T extends IdentityRelationRecord> = {
  heads: Array<IdentityRelationEvent & { record: T }>;
  record: T;
};

type IdentityRelationState = {
  endpoints: Map<string, IdentityRecordState<IdentityEndpointAccount>>;
  participants: Map<string, IdentityRecordState<IdentityParticipant>>;
  relations: Map<string, IdentityRecordState<IdentityRelationCard>>;
};

function text(value: unknown, limit = MAX_TEXT): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  return normalized || undefined;
}

function requiredText(value: unknown, label: string, limit = MAX_TEXT): string {
  const normalized = text(value, limit);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function list(value: unknown, limit = MAX_LIST): string[] {
  if (!Array.isArray(value)) throw new Error("Expected an array.");
  return [...new Set(value.flatMap(item => text(item, 300) ? [text(item, 300)!] : []))].slice(0, limit);
}

function status(value: unknown, fallback: IdentityRelationStatus): IdentityRelationStatus {
  const normalized = text(value, 30);
  if (!normalized) return fallback;
  if (["candidate", "confirmed", "corrected", "retired"].includes(normalized)) return normalized as IdentityRelationStatus;
  throw new Error("Identity relation status must be candidate, confirmed, corrected, or retired.");
}

function participantKind(value: unknown, fallback: IdentityParticipantKind): IdentityParticipantKind {
  const normalized = text(value, 30);
  if (!normalized) return fallback;
  if (["person", "organization", "shared_account", "automated", "unknown"].includes(normalized)) return normalized as IdentityParticipantKind;
  throw new Error("Invalid participant kind.");
}

function targetKind(value: unknown): IdentityRelationTargetKind {
  const normalized = requiredText(value, "targetKind", 30);
  if (["participant", "organization", "project"].includes(normalized)) return normalized as IdentityRelationTargetKind;
  throw new Error("Invalid relation target kind.");
}

function confidence(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("Identity confidence must be between 0 and 1.");
  return parsed;
}

function evidenceRefs(value: unknown): IdentityEvidenceRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Identity evidenceRefs must be an array.");
  return value.slice(0, MAX_LIST).flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const candidate: IdentityEvidenceRef = {
      gatewayId: text(raw.gatewayId, 300),
      routeId: text(raw.routeId, 300),
      endpoint: text(raw.endpoint, 300),
      conversationKey: text(raw.conversationKey, 600),
      messageId: text(raw.messageId, 300),
      note: text(raw.note, 600)
    };
    return Object.values(candidate).some(Boolean) ? [candidate] : [];
  });
}

const SPEAKING_HABIT_DIMENSIONS = new Set<IdentitySpeakingHabitDimension>([
  "sentence_opening", "sentence_length", "stance_expression", "emotion_threshold",
  "analogy_source", "punctuation", "reader_relationship", "value_preference",
  "information_order", "avoidance", "imperfection", "scene_boundary"
]);

function speakingHabits(value: unknown): IdentitySpeakingHabit[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Identity speakingHabits must be an array.");
  return value.slice(0, 24).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each speaking habit must be an object.");
    const raw = item as Record<string, unknown>;
    const dimension = requiredText(raw.dimension, "speakingHabit.dimension", 60) as IdentitySpeakingHabitDimension;
    if (!SPEAKING_HABIT_DIMENSIONS.has(dimension)) throw new Error("Invalid speaking-habit dimension.");
    const refs = evidenceRefs(raw.evidenceRefs);
    if (!refs.some(ref => ref.messageId)) {
      throw new Error("Speaking-habit evidence requires at least one confirmed-author messageId.");
    }
    return {
      dimension,
      description: requiredText(raw.description, "speakingHabit.description", 600),
      confidence: confidence(raw.confidence),
      evidenceRefs: refs
    };
  });
}

function scope(value: unknown): IdentityScope {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    conversationKeys: raw.conversationKeys == null ? [] : list(raw.conversationKeys),
    projectIds: raw.projectIds == null ? [] : list(raw.projectIds)
  };
}

function participantLinks(value: unknown): IdentityParticipantLink[] {
  if (!Array.isArray(value)) throw new Error("Identity participantLinks must be an array.");
  const parsed = value.slice(0, MAX_LIST).flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    return [{
      participantId: requiredText(raw.participantId, "participantLink.participantId", 300),
      status: status(raw.status, "candidate"),
      confidence: confidence(raw.confidence),
      evidenceRefs: evidenceRefs(raw.evidenceRefs)
    }];
  });
  if (new Set(parsed.map(item => item.participantId)).size !== parsed.length) {
    throw new Error("An endpoint account may contain at most one link for each participant.");
  }
  return parsed;
}

function endpointAccountId(platform: string, namespace: string, senderStableId: string): string {
  const digest = createHash("sha256").update(platform).update("\0").update(namespace).update("\0").update(senderStableId).digest("hex").slice(0, 32);
  return `identity-account-${digest}`;
}

function observedParticipantId(accountId: string): string {
  return `identity-participant-observed-${accountId.replace(/^identity-account-/, "")}`;
}

function observedRelationId(
  participantId: string,
  relation: Pick<IdentityCandidateRelationObservation, "targetKind" | "targetId" | "relationship"> & { scope: IdentityScope }
): string {
  const digest = createHash("sha256")
    .update(participantId)
    .update("\0")
    .update(relation.targetKind)
    .update("\0")
    .update(relation.targetId)
    .update("\0")
    .update(relation.relationship)
    .update("\0")
    .update(JSON.stringify({
      conversationKeys: [...relation.scope.conversationKeys].sort(),
      projectIds: [...relation.scope.projectIds].sort()
    }))
    .digest("hex")
    .slice(0, 32);
  return `identity-relation-observed-${digest}`;
}

function uniqueEvidenceRefs(...groups: IdentityEvidenceRef[][]): IdentityEvidenceRef[] {
  const seen = new Set<string>();
  return groups.flat().flatMap(item => {
    const normalized = evidenceRefs([item])[0];
    if (!normalized) return [];
    const key = JSON.stringify(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  }).slice(-MAX_LIST);
}

function generatedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function identityRelationsPath(roleDir: string): string {
  return path.join(path.resolve(roleDir), "identity-relations", "events.jsonl");
}

function validEvent(value: unknown): value is IdentityRelationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<IdentityRelationEvent>;
  return item.schemaVersion === 1
    && item.knowledgeType === IDENTITY_RELATION_KNOWLEDGE_TYPE
    && Boolean(text(item.id, 300))
    && (item.recordKind === "endpoint_account" || item.recordKind === "participant" || item.recordKind === "relation_card")
    && Boolean(item.record && typeof item.record === "object" && text((item.record as { id?: unknown }).id, 300));
}

function events(roleDir: string): IdentityRelationEvent[] {
  const filePath = identityRelationsPath(roleDir);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as unknown;
      return validEvent(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function eventSupersedes(event: IdentityRelationEvent): string[] | undefined {
  if (!has(event, "supersedes")) return undefined;
  const raw = Array.isArray(event.supersedes) ? event.supersedes : [event.supersedes];
  return [...new Set(raw.flatMap(item => {
    const id = text(item, 300);
    return id && id !== event.id ? [id] : [];
  }))];
}

function comparableRecord(record: IdentityRelationRecord): string {
  const {
    updatedAt: _updatedAt,
    conflicted: _conflicted,
    conflictEventIds: _conflictEventIds,
    conflictCandidates: _conflictCandidates,
    ...value
  } = record;
  return JSON.stringify(value);
}

function conflictComparableRecord(record: IdentityRelationRecord): string {
  const {
    updatedAt: _updatedAt,
    conflicted: _conflicted,
    conflictEventIds: _conflictEventIds,
    conflictCandidates: _conflictCandidates,
    ...value
  } = record;
  if ("platform" in value) {
    const { displayName: _displayName, ...identityValue } = value;
    return JSON.stringify(identityValue);
  }
  if ("kind" in value
    && value.id.startsWith("identity-participant-observed-")
    && value.kind === "unknown"
    && value.status === "candidate") {
    const {
      displayName: _displayName,
      aliases: _aliases,
      evidenceRefs: _evidenceRefs,
      ...identityValue
    } = value;
    return JSON.stringify(identityValue);
  }
  return JSON.stringify(value);
}

function mergedEquivalentRecord<T extends IdentityRelationRecord>(
  heads: Array<IdentityRelationEvent & { record: T }>
): T {
  const byTime = [...heads].sort((left, right) =>
    left.record.updatedAt.localeCompare(right.record.updatedAt) || left.id.localeCompare(right.id)
  );
  const selected = byTime.at(-1)!.record;
  if ("platform" in selected) {
    const endpoints = byTime.map(item => item.record).filter((record): record is T & IdentityEndpointAccount => "platform" in record);
    const latestName = [...endpoints].reverse().find(record => record.displayName)?.displayName;
    return { ...selected, displayName: latestName } as T;
  }
  if ("kind" in selected
    && selected.id.startsWith("identity-participant-observed-")
    && selected.kind === "unknown"
    && selected.status === "candidate") {
    const participants = byTime.map(item => item.record).filter((record): record is T & IdentityParticipant => "kind" in record);
    const latestName = [...participants].reverse().find(record => record.displayName)?.displayName;
    return {
      ...selected,
      displayName: latestName,
      aliases: [...new Set(participants.flatMap(record => record.aliases))].slice(0, MAX_LIST),
      evidenceRefs: uniqueEvidenceRefs(...participants.map(record => record.evidenceRefs))
    } as T;
  }
  return selected;
}

function collapseRecordState<T extends IdentityRelationRecord>(heads: Array<IdentityRelationEvent & { record: T }>): T {
  const sorted = [...heads].sort((left, right) => left.id.localeCompare(right.id));
  const selected = mergedEquivalentRecord(sorted);
  const different = new Set(sorted.map(item => conflictComparableRecord(item.record))).size > 1;
  if (!different) return {
    ...selected,
    conflicted: undefined,
    conflictEventIds: undefined,
    conflictCandidates: undefined
  } as T;
  return {
    ...selected,
    conflicted: true,
    conflictEventIds: sorted.map(item => item.id),
    conflictCandidates: sorted.map(item => ({ eventId: item.id, record: item.record }))
  } as T;
}

function state(roleDir: string): IdentityRelationState {
  const grouped = new Map<IdentityRelationPatch["kind"], Map<string, IdentityRelationEvent[]>>();
  for (const event of events(roleDir)) {
    const id = event.record.id;
    const byId = grouped.get(event.recordKind) ?? new Map<string, IdentityRelationEvent[]>();
    const group = byId.get(id) ?? [];
    group.push(event);
    byId.set(id, group);
    grouped.set(event.recordKind, byId);
  }
  const result: IdentityRelationState = { endpoints: new Map(), participants: new Map(), relations: new Map() };
  for (const [kind, byId] of grouped) for (const [id, group] of byId) {
    const explicitSuperseded = new Set(group.flatMap(event => eventSupersedes(event) ?? []));
    const inferredSuperseded = new Set<string>();
    const currentHeads = new Set<string>();
    for (const event of group) {
      const parents = eventSupersedes(event) ?? [...currentHeads];
      for (const parent of parents) {
        inferredSuperseded.add(parent);
        currentHeads.delete(parent);
      }
      if (!explicitSuperseded.has(event.id)) currentHeads.add(event.id);
    }
    const superseded = new Set([...explicitSuperseded, ...inferredSuperseded]);
    let heads = group.filter(event => !superseded.has(event.id));
    if (heads.length === 0 && group.length > 0) heads = [group.at(-1)!];
    if (kind === "endpoint_account") {
      const typedHeads = heads as Array<IdentityRelationEvent & { record: IdentityEndpointAccount }>;
      result.endpoints.set(id, { heads: typedHeads, record: collapseRecordState(typedHeads) });
    } else if (kind === "participant") {
      const typedHeads = heads as Array<IdentityRelationEvent & { record: IdentityParticipant }>;
      result.participants.set(id, { heads: typedHeads, record: collapseRecordState(typedHeads) });
    } else {
      const typedHeads = heads as Array<IdentityRelationEvent & { record: IdentityRelationCard }>;
      result.relations.set(id, { heads: typedHeads, record: collapseRecordState(typedHeads) });
    }
  }
  return result;
}

export function listIdentityEndpointAccounts(roleDir: string): IdentityEndpointAccount[] {
  return [...state(roleDir).endpoints.values()].map(item => item.record).sort((a, b) => a.id.localeCompare(b.id));
}

export function listIdentityParticipants(roleDir: string): IdentityParticipant[] {
  return [...state(roleDir).participants.values()].map(item => item.record).sort((a, b) => a.id.localeCompare(b.id));
}

export function listIdentityRelationCards(roleDir: string): IdentityRelationCard[] {
  return [...state(roleDir).relations.values()].map(item => item.record).sort((a, b) => a.id.localeCompare(b.id));
}

export function listIdentityRelationConflicts(roleDir: string): IdentityRelationConflict[] {
  const current = state(roleDir);
  const collect = <T extends IdentityRelationRecord>(
    recordKind: IdentityRelationPatch["kind"],
    records: Map<string, IdentityRecordState<T>>
  ) => [...records.values()].flatMap(item => item.record.conflicted ? [{
    recordKind,
    recordId: item.record.id,
    candidateEventIds: item.record.conflictEventIds ?? []
  }] : []);
  return [
    ...collect("endpoint_account", current.endpoints),
    ...collect("participant", current.participants),
    ...collect("relation_card", current.relations)
  ].sort((left, right) => `${left.recordKind}:${left.recordId}`.localeCompare(`${right.recordKind}:${right.recordId}`));
}

function requireConflictResolutionFields(existing: IdentityRelationRecord | undefined, patch: IdentityRelationPatch): void {
  if (!existing?.conflicted) return;
  const required = patch.kind === "endpoint_account"
    ? ["participantLinks"]
    : patch.kind === "participant"
      ? ["participantKind", "displayName", "aliases", "status", "evidenceRefs"]
      : ["subjectParticipantId", "targetKind", "targetId", "relationship", "status", "scope", "evidenceRefs"];
  const missing = required.filter(key => !has(patch, key));
  if (missing.length > 0) {
    throw new Error(`Resolving a conflicted identity relation requires explicit fields: ${missing.join(", ")}.`);
  }
}

function requireCurrentParticipant(
  current: IdentityRelationState,
  participantId: string,
  label: string,
  authoritative = false
): IdentityParticipant {
  const participant = current.participants.get(participantId)?.record;
  if (!participant) throw new Error(`${label} must reference an existing identity participant.`);
  if (participant.conflicted) throw new Error(`${label} cannot reference a conflicted identity participant.`);
  if (!isActiveIdentityStatus(participant.status)) throw new Error(`${label} cannot reference a retired identity participant.`);
  if (authoritative && !isAuthoritativeIdentityStatus(participant.status)) {
    throw new Error(`${label} must reference a confirmed or corrected identity participant.`);
  }
  return participant;
}

function validateParticipantLinks(current: IdentityRelationState, links: IdentityParticipantLink[]): void {
  const authoritativeLinks = links.filter(link => isAuthoritativeIdentityStatus(link.status));
  if (authoritativeLinks.length > 1) {
    throw new Error("An endpoint account may contain at most one confirmed or corrected participant link.");
  }
  for (const link of links) {
    if (!isActiveIdentityStatus(link.status)) continue;
    requireCurrentParticipant(
      current,
      link.participantId,
      "participantLink.participantId",
      isAuthoritativeIdentityStatus(link.status)
    );
  }
}

export function updateIdentityRelation(roleDir: string, patch: IdentityRelationPatch): {
  record: IdentityRelationRecord;
  appended: boolean;
} {
  if (!patch || typeof patch !== "object") throw new Error("Identity relation patch is required.");
  const filePath = identityRelationsPath(roleDir);
  return withFileLockSync(`${filePath}.lock`, () => {
    const current = state(roleDir);
    const now = new Date().toISOString();
    let record: IdentityRelationRecord;
    let heads: IdentityRelationEvent[] = [];
    if (patch.kind === "endpoint_account") {
      const platform = requiredText(patch.platform, "platform", 100);
      const endpointIdentityNamespace = requiredText(patch.endpointIdentityNamespace, "endpointIdentityNamespace", 300);
      const senderStableId = requiredText(patch.senderStableId, "senderStableId", 300);
      const id = endpointAccountId(platform, endpointIdentityNamespace, senderStableId);
      const existing = current.endpoints.get(id);
      requireConflictResolutionFields(existing?.record, patch);
      heads = existing?.heads ?? [];
      const nextParticipantLinks = has(patch, "participantLinks") ? participantLinks(patch.participantLinks) : existing?.record.participantLinks ?? [];
      validateParticipantLinks(current, nextParticipantLinks);
      record = {
        id,
        platform,
        endpointIdentityNamespace,
        senderStableId,
        displayName: has(patch, "displayName") ? text(patch.displayName, 300) : existing?.record.displayName,
        isSelf: has(patch, "isSelf") ? (typeof patch.isSelf === "boolean" ? patch.isSelf : undefined) : existing?.record.isSelf,
        participantLinks: nextParticipantLinks,
        updatedAt: now
      };
    } else if (patch.kind === "participant") {
      const id = text(patch.participantId, 300) || generatedId("identity-participant");
      const existing = current.participants.get(id);
      requireConflictResolutionFields(existing?.record, patch);
      heads = existing?.heads ?? [];
      record = {
        id,
        kind: participantKind(patch.participantKind, existing?.record.kind ?? "unknown"),
        displayName: has(patch, "displayName") ? text(patch.displayName, 300) : existing?.record.displayName,
        aliases: has(patch, "aliases") ? list(patch.aliases) : existing?.record.aliases ?? [],
        speakingHabits: has(patch, "speakingHabits") ? speakingHabits(patch.speakingHabits) : existing?.record.speakingHabits ?? [],
        status: status(patch.status, existing?.record.status ?? "candidate"),
        evidenceRefs: has(patch, "evidenceRefs") ? evidenceRefs(patch.evidenceRefs) : existing?.record.evidenceRefs ?? [],
        updatedAt: now
      };
    } else if (patch.kind === "relation_card") {
      const id = text(patch.relationId, 300) || generatedId("identity-relation");
      const existing = current.relations.get(id);
      requireConflictResolutionFields(existing?.record, patch);
      heads = existing?.heads ?? [];
      record = {
        id,
        subjectParticipantId: requiredText(patch.subjectParticipantId ?? existing?.record.subjectParticipantId, "subjectParticipantId", 300),
        targetKind: targetKind(patch.targetKind ?? existing?.record.targetKind),
        targetId: requiredText(patch.targetId ?? existing?.record.targetId, "targetId", 300),
        relationship: requiredText(patch.relationship ?? existing?.record.relationship, "relationship", 600),
        status: status(patch.status, existing?.record.status ?? "candidate"),
        scope: has(patch, "scope") ? scope(patch.scope) : existing?.record.scope ?? { conversationKeys: [], projectIds: [] },
        evidenceRefs: has(patch, "evidenceRefs") ? evidenceRefs(patch.evidenceRefs) : existing?.record.evidenceRefs ?? [],
        updatedAt: now
      };
      if (isActiveIdentityRelationStatus(record.status)) {
        requireCurrentParticipant(current, record.subjectParticipantId, "subjectParticipantId");
        if (record.targetKind === "participant") {
          requireCurrentParticipant(current, record.targetId, "targetId");
        }
      }
    } else {
      throw new Error("Unsupported identity relation kind.");
    }
    const existing = patch.kind === "endpoint_account"
      ? current.endpoints.get(record.id)?.record
      : patch.kind === "participant"
        ? current.participants.get(record.id)?.record
        : current.relations.get(record.id)?.record;
    if (!existing?.conflicted && existing && comparableRecord(existing) === comparableRecord(record)) {
      recordDataMutationAudit({
        group: "identity",
        event: "identity_relation_unchanged",
        owner: "identity-relations",
        action: `update-${patch.kind}`,
        target: { type: patch.kind, id: record.id },
        dataSource: { kind: "ledger", id: "identity/relations.jsonl" },
        outcome: "no_change",
        after: { revision: existing.updatedAt }
      });
      return { record: existing, appended: false };
    }
    const event: IdentityRelationEvent = {
      schemaVersion: 1,
      knowledgeType: IDENTITY_RELATION_KNOWLEDGE_TYPE,
      id: `identity-relation-event-${randomUUID()}`,
      recordKind: patch.kind,
      record,
      createdAt: now,
      supersedes: heads.map(item => item.id).sort()
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "identity",
        event: "identity_relation_append_failed",
        owner: "identity-relations",
        action: `update-${patch.kind}`,
        target: { type: patch.kind, id: record.id },
        dataSource: { kind: "ledger", id: "identity/relations.jsonl" },
        outcome: "failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "identity",
      event: "identity_relation_appended",
      owner: "identity-relations",
      action: `update-${patch.kind}`,
      target: { type: patch.kind, id: record.id },
      dataSource: { kind: "ledger", id: "identity/relations.jsonl" },
      outcome: "committed",
      before: heads.length > 0 ? { revision: heads.map(item => item.id).sort().join(",") } : undefined,
      after: { revision: event.id },
      changes: [{ field: "supersededHeadCount", to: heads.length }]
    });
    return { record, appended: true };
  });
}

/**
 * Creates a reversible candidate for a stable endpoint account. Display names are clues only:
 * this function never confirms identity, merges accounts, or grants project authority.
 */
export function observeIdentityEndpoint(
  roleDir: string,
  lookup: IdentityEndpointLookup
): IdentityEndpointObservationResult {
  const platform = text(lookup.platform, 100);
  const endpointIdentityNamespace = text(lookup.endpointIdentityNamespace, 300);
  const senderStableId = text(lookup.senderStableId, 300);
  if (!platform || !endpointIdentityNamespace || !senderStableId) {
    return { accountCreated: false, participantCreated: false, updated: false };
  }
  const accountId = endpointAccountId(platform, endpointIdentityNamespace, senderStableId);
  const before = state(roleDir);
  const existingAccount = before.endpoints.get(accountId)?.record;
  const authoritativeLink = existingAccount?.participantLinks.find(link => isAuthoritativeIdentityStatus(link.status));
  if (existingAccount?.conflicted || existingAccount?.isSelf || authoritativeLink) {
    return {
      context: resolveIdentityRelationContext(roleDir, lookup),
      participantId: authoritativeLink?.participantId,
      accountCreated: false,
      participantCreated: false,
      updated: false
    };
  }

  const endpoint = `${platform}/${endpointIdentityNamespace}/${senderStableId}`;
  const automaticEvidence: IdentityEvidenceRef[] = [{
    endpoint,
    note: "系统首次看到此稳定消息端账号，身份仍待确认。"
  }];
  const candidateLinks = existingAccount?.participantLinks.filter(link => link.status === "candidate") ?? [];
  const deterministicParticipantId = observedParticipantId(accountId);
  const deterministicParticipant = before.participants.get(deterministicParticipantId)?.record;
  const newCandidateParticipantId = deterministicParticipant
    ? generatedId("identity-participant-observed")
    : deterministicParticipantId;
  const participantId = candidateLinks.length === 1
    ? candidateLinks[0]!.participantId
    : candidateLinks.length === 0
      ? newCandidateParticipantId
      : undefined;
  if (!participantId) {
    return {
      context: resolveIdentityRelationContext(roleDir, lookup),
      accountCreated: false,
      participantCreated: false,
      updated: false
    };
  }

  const existingParticipant = before.participants.get(participantId)?.record;
  const observedName = text(lookup.displayName, 300);
  let participantCreated = false;
  let updated = false;
  if (!existingParticipant || (!existingParticipant.conflicted && existingParticipant.status === "candidate")) {
    const aliases = [...new Set([
      ...(existingParticipant?.aliases ?? []),
      ...(observedName ? [observedName] : [])
    ])].slice(0, MAX_LIST);
    const participantResult = updateIdentityRelation(roleDir, {
      kind: "participant",
      participantId,
      participantKind: existingParticipant?.kind ?? "unknown",
      displayName: existingParticipant?.displayName ?? observedName,
      aliases,
      status: "candidate",
      evidenceRefs: uniqueEvidenceRefs(existingParticipant?.evidenceRefs ?? [], automaticEvidence)
    });
    participantCreated = !existingParticipant && participantResult.appended;
    updated ||= participantResult.appended;
  }

  const linkEvidence = candidateLinks.find(link => link.participantId === participantId)?.evidenceRefs ?? automaticEvidence;
  const accountResult = updateIdentityRelation(roleDir, {
    kind: "endpoint_account",
    platform,
    endpointIdentityNamespace,
    senderStableId,
    displayName: observedName ?? existingAccount?.displayName,
    isSelf: existingAccount?.isSelf,
    participantLinks: candidateLinks.some(link => link.participantId === participantId)
      ? existingAccount?.participantLinks ?? []
      : [
          ...(existingAccount?.participantLinks ?? []),
          { participantId, status: "candidate", confidence: 0.1, evidenceRefs: linkEvidence }
        ]
  });
  updated ||= accountResult.appended;
  return {
    context: resolveIdentityRelationContext(roleDir, lookup),
    participantId,
    accountCreated: !existingAccount && accountResult.appended,
    participantCreated,
    updated
  };
}

/**
 * Adds evidence-backed clues to an existing candidate. Automatic learning is deliberately
 * unable to confirm a person or attach authority; confirmation remains an explicit review action.
 */
export function recordIdentityCandidateObservation(
  roleDir: string,
  observation: IdentityCandidateObservation
): {
  participant: IdentityParticipant;
  relations: IdentityRelationCard[];
  appended: boolean;
} {
  const platform = requiredText(observation.platform, "platform", 100);
  const endpointIdentityNamespace = requiredText(observation.endpointIdentityNamespace, "endpointIdentityNamespace", 300);
  const senderStableId = requiredText(observation.senderStableId, "senderStableId", 300);
  const current = state(roleDir);
  const account = current.endpoints.get(endpointAccountId(platform, endpointIdentityNamespace, senderStableId))?.record;
  if (!account) throw new Error("Observe the endpoint account before adding identity clues.");
  if (account.conflicted) throw new Error("A conflicted endpoint account cannot learn identity clues automatically.");
  if (account.isSelf) throw new Error("The persona's own endpoint account cannot be learned as an external participant.");
  if (account.participantLinks.some(link => isAuthoritativeIdentityStatus(link.status))) {
    throw new Error("A confirmed endpoint account no longer accepts automatic candidate learning.");
  }
  const requestedParticipantId = text(observation.participantId, 300);
  const candidateLinks = account.participantLinks.filter(link => link.status === "candidate");
  const link = requestedParticipantId
    ? candidateLinks.find(item => item.participantId === requestedParticipantId)
    : candidateLinks.length === 1 ? candidateLinks[0] : undefined;
  if (!link) throw new Error("Identity clues require one existing candidate participant linked to this endpoint account.");
  const existingParticipant = current.participants.get(link.participantId)?.record;
  if (!existingParticipant || existingParticipant.conflicted || existingParticipant.status !== "candidate") {
    throw new Error("Identity clues can update only an unconflicted candidate participant.");
  }

  const displayName = text(observation.participantDisplayName, 300) ?? existingParticipant.displayName;
  const aliases = [...new Set([
    ...existingParticipant.aliases,
    ...(Array.isArray(observation.aliases) ? observation.aliases.flatMap(item => text(item, 300) ? [text(item, 300)!] : []) : []),
    ...(displayName ? [displayName] : [])
  ])].slice(0, MAX_LIST);
  const observationEvidence = evidenceRefs(observation.evidenceRefs);
  if (observationEvidence.length === 0) throw new Error("Candidate identity clues require at least one evidence reference.");
  if (!observationEvidence.some(item => item.messageId)) {
    throw new Error("Candidate identity clues require a source messageId.");
  }
  const preparedRelations = (observation.relations ?? []).slice(0, MAX_LIST).map(raw => {
    const relationScope = scope(raw.scope ?? {
      conversationKeys: observation.conversationKey ? [observation.conversationKey] : [],
      projectIds: observation.projectId ? [observation.projectId] : []
    });
    const relation: IdentityCandidateRelationObservation & { scope: IdentityScope } = {
      targetKind: targetKind(raw.targetKind),
      targetId: requiredText(raw.targetId, "relation.targetId", 300),
      relationship: requiredText(raw.relationship, "relation.relationship", 600),
      scope: relationScope,
      evidenceRefs: raw.evidenceRefs
    };
    const relationId = observedRelationId(existingParticipant.id, relation);
    const existingRelation = current.relations.get(relationId)?.record;
    if (existingRelation?.conflicted || (existingRelation && existingRelation.status !== "candidate")) {
      throw new Error("Automatic identity learning cannot overwrite a conflicted or confirmed relation.");
    }
    return { relation, relationId, existingRelation };
  });

  const participantResult = updateIdentityRelation(roleDir, {
    kind: "participant",
    participantId: existingParticipant.id,
    participantKind: observation.participantKind ?? existingParticipant.kind,
    displayName,
    aliases,
    status: "candidate",
    evidenceRefs: uniqueEvidenceRefs(existingParticipant.evidenceRefs, observationEvidence)
  });

  const relationResults = preparedRelations.map(({ relation, relationId, existingRelation }) => {
    return updateIdentityRelation(roleDir, {
      kind: "relation_card",
      relationId,
      subjectParticipantId: existingParticipant.id,
      targetKind: relation.targetKind,
      targetId: relation.targetId,
      relationship: relation.relationship,
      status: "candidate",
      scope: relation.scope,
      evidenceRefs: uniqueEvidenceRefs(existingRelation?.evidenceRefs ?? [], evidenceRefs(relation.evidenceRefs), observationEvidence)
    });
  });
  return {
    participant: participantResult.record as IdentityParticipant,
    relations: relationResults.map(item => item.record as IdentityRelationCard),
    appended: participantResult.appended || relationResults.some(item => item.appended)
  };
}

function appliesToScope(card: IdentityRelationCard, lookup: IdentityEndpointLookup): boolean {
  if (card.scope.conversationKeys.length > 0 && (!lookup.conversationKey || !card.scope.conversationKeys.includes(lookup.conversationKey))) return false;
  if (card.scope.projectIds.length > 0 && (!lookup.projectId || !card.scope.projectIds.includes(lookup.projectId))) return false;
  return true;
}

function usableParticipant(item: IdentityParticipant | undefined): item is IdentityParticipant {
  return Boolean(item && !item.conflicted && isActiveIdentityStatus(item.status));
}

export function resolveIdentityRelationContext(roleDir: string, lookup: IdentityEndpointLookup): IdentityRelationContext | undefined {
  const platform = text(lookup.platform, 100);
  const endpointIdentityNamespace = text(lookup.endpointIdentityNamespace, 300);
  const senderStableId = text(lookup.senderStableId, 300);
  if (!platform || !endpointIdentityNamespace || !senderStableId) return undefined;
  const current = state(roleDir);
  const account = current.endpoints.get(endpointAccountId(platform, endpointIdentityNamespace, senderStableId))?.record;
  const endpoint: IdentityRelationContext["endpoint"] = account
    ? {
        id: account.id,
        platform: account.platform,
        endpointIdentityNamespace: account.endpointIdentityNamespace,
        senderStableId: account.senderStableId,
        displayName: account.displayName ?? text(lookup.displayName, 300),
        isSelf: account.isSelf
      }
    : {
        id: endpointAccountId(platform, endpointIdentityNamespace, senderStableId),
        platform,
        endpointIdentityNamespace,
        senderStableId,
        displayName: text(lookup.displayName, 300)
      };
  const links = account && !account.conflicted ? account.participantLinks : [];
  const rawConfirmedLinks = links.filter(link => isAuthoritativeIdentityStatus(link.status));
  const confirmedMatches = rawConfirmedLinks.flatMap(link => {
    const participant = current.participants.get(link.participantId)?.record;
    return usableParticipant(participant) && isAuthoritativeIdentityStatus(participant.status) ? [{ participant, link }] : [];
  });
  const confirmedParticipant = confirmedMatches.length === 1 && rawConfirmedLinks.length === 1 ? confirmedMatches[0]!.participant : undefined;
  const linkedCandidates = links
    .filter(link => link.status === "candidate")
    .flatMap(link => {
      const participant = current.participants.get(link.participantId)?.record;
      return usableParticipant(participant) ? [{ participant, link }] : [];
    });
  const possibleParticipants = linkedCandidates.filter(item => isAuthoritativeIdentityStatus(item.participant.status));
  const candidateParticipants = linkedCandidates.filter(item => !isAuthoritativeIdentityStatus(item.participant.status));
  const participantIds = new Set([
    confirmedParticipant?.id,
    ...possibleParticipants.map(item => item.participant.id),
    ...candidateParticipants.map(item => item.participant.id)
  ].filter(Boolean));
  const relevantRelations = [...current.relations.values()]
    .map(item => item.record)
    .filter(card => !card.conflicted
      && isActiveIdentityRelationStatus(card.status)
      && appliesToScope(card, lookup)
      && (participantIds.has(card.subjectParticipantId) || (card.targetKind === "participant" && participantIds.has(card.targetId))))
    .sort((a, b) => a.id.localeCompare(b.id));
  const unresolved: string[] = [];
  if (!account) unresolved.push("当前账号尚未建立身份关系记录。");
  if (account?.conflicted) unresolved.push("当前账号的身份映射存在并发冲突；在人工收敛前不得自动确认身份。");
  if (rawConfirmedLinks.length > 1) {
    unresolved.push("当前账号存在多个已确认参与者映射，需人工纠正。");
  } else if (!confirmedParticipant && possibleParticipants.length === 0) {
    unresolved.push("当前账号尚无唯一且有效的已确认参与者映射。");
  }
  if (possibleParticipants.length > 0) unresolved.push("该账号与已识别人员存在非唯一关联；当前使用者需要结合本次对话另行判断。");
  if (candidateParticipants.length > 0) unresolved.push("候选参与者只能作为核对线索，不能用于称呼、授权或项目归属判断。");
  return { endpoint, confirmedParticipant, possibleParticipants, candidateParticipants, relevantRelations, unresolved };
}
