import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./shared/filePersistence.js";

const MAX_TEXT = 2_000;
const MAX_LIST = 50;

/** Kept outside keyword recall and recent-memory consolidation. */
export const IDENTITY_RELATION_KNOWLEDGE_TYPE = "identity_relation" as const;
export type IdentityRelationKnowledgeType = typeof IDENTITY_RELATION_KNOWLEDGE_TYPE;
export type IdentityRelationStatus = "candidate" | "confirmed" | "corrected" | "retired";
export type IdentityParticipantKind = "person" | "organization" | "shared_account" | "automated" | "unknown";
export type IdentityRelationTargetKind = "participant" | "organization" | "project";

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

function collapseRecordState<T extends IdentityRelationRecord>(heads: Array<IdentityRelationEvent & { record: T }>): T {
  const sorted = [...heads].sort((left, right) => left.id.localeCompare(right.id));
  const selected = sorted.at(-1)!.record;
  const different = new Set(sorted.map(item => comparableRecord(item.record))).size > 1;
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
      record = {
        id,
        platform,
        endpointIdentityNamespace,
        senderStableId,
        displayName: has(patch, "displayName") ? text(patch.displayName, 300) : existing?.record.displayName,
        isSelf: has(patch, "isSelf") ? (typeof patch.isSelf === "boolean" ? patch.isSelf : undefined) : existing?.record.isSelf,
        participantLinks: has(patch, "participantLinks") ? participantLinks(patch.participantLinks) : existing?.record.participantLinks ?? [],
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
    } else {
      throw new Error("Unsupported identity relation kind.");
    }
    const existing = patch.kind === "endpoint_account"
      ? current.endpoints.get(record.id)?.record
      : patch.kind === "participant"
        ? current.participants.get(record.id)?.record
        : current.relations.get(record.id)?.record;
    if (!existing?.conflicted && existing && comparableRecord(existing) === comparableRecord(record)) {
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return { record, appended: true };
  });
}

function appliesToScope(card: IdentityRelationCard, lookup: IdentityEndpointLookup): boolean {
  if (card.scope.conversationKeys.length > 0 && (!lookup.conversationKey || !card.scope.conversationKeys.includes(lookup.conversationKey))) return false;
  if (card.scope.projectIds.length > 0 && (!lookup.projectId || !card.scope.projectIds.includes(lookup.projectId))) return false;
  return true;
}

function usableParticipant(item: IdentityParticipant | undefined): item is IdentityParticipant {
  return Boolean(item && !item.conflicted && (item.status === "candidate" || item.status === "confirmed"));
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
  const rawConfirmedLinks = links.filter(link => link.status === "confirmed");
  const confirmedMatches = rawConfirmedLinks.flatMap(link => {
    const participant = current.participants.get(link.participantId)?.record;
    return usableParticipant(participant) && participant.status === "confirmed" ? [{ participant, link }] : [];
  });
  const confirmedParticipant = confirmedMatches.length === 1 && rawConfirmedLinks.length === 1 ? confirmedMatches[0]!.participant : undefined;
  const candidateParticipants = links
    .filter(link => link.status === "candidate")
    .flatMap(link => {
      const participant = current.participants.get(link.participantId)?.record;
      return usableParticipant(participant) ? [{ participant, link }] : [];
    });
  const participantIds = new Set([confirmedParticipant?.id, ...candidateParticipants.map(item => item.participant.id)].filter(Boolean));
  const relevantRelations = [...current.relations.values()]
    .map(item => item.record)
    .filter(card => !card.conflicted
      && (card.status === "candidate" || card.status === "confirmed")
      && appliesToScope(card, lookup)
      && (participantIds.has(card.subjectParticipantId) || (card.targetKind === "participant" && participantIds.has(card.targetId))))
    .sort((a, b) => a.id.localeCompare(b.id));
  const unresolved: string[] = [];
  if (!account) unresolved.push("当前账号尚未建立身份关系记录。");
  if (account?.conflicted) unresolved.push("当前账号的身份映射存在并发冲突；在人工收敛前不得自动确认身份。");
  if (rawConfirmedLinks.length !== 1 || !confirmedParticipant) {
    unresolved.push(rawConfirmedLinks.length > 1 ? "当前账号存在多个已确认参与者映射，需人工纠正。" : "当前账号尚无唯一且有效的已确认参与者映射。");
  }
  if (candidateParticipants.length > 0) unresolved.push("候选参与者只能作为核对线索，不能用于称呼、授权或项目归属判断。");
  return { endpoint, confirmedParticipant, candidateParticipants, relevantRelations, unresolved };
}
