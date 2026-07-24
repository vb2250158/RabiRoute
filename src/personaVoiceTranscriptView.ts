import {
  recentMessageContextItems,
  type MessageContextRecord,
  type MessageContextSpeechSegment
} from "./messageContextStore.js";
import {
  listPersonaVoiceIdentities,
  type PersonaVoiceIdentity
} from "./personaVoiceIdentities.js";

export type PersonaVoiceSpeakerClassification = "user" | "other" | "unknown" | "conflict";
export type PersonaVoiceRecordClassification = PersonaVoiceSpeakerClassification | "mixed";

export type PersonaVoiceEvidence = {
  voiceprintId: string;
  identity?: PersonaVoiceIdentity;
};

export type PersonaVoiceSegmentView = {
  segment: MessageContextSpeechSegment;
  classification: PersonaVoiceSpeakerClassification;
  evidence: PersonaVoiceEvidence[];
};

export type PersonaVoiceTranscriptView = {
  record: MessageContextRecord;
  personaClassification: PersonaVoiceRecordClassification;
  evidence: PersonaVoiceEvidence[];
  segmentViews: PersonaVoiceSegmentView[];
};

export type PersonaVoiceClassificationStats = {
  records: number;
  segments: number;
  speakerDurationSeconds: number;
};

export type PersonaVoiceUnresolvedVoiceprint = {
  sourceHostId?: string;
  sourceHostName?: string;
  voiceprintId: string;
  classification: "unknown" | "conflict";
  segments: number;
  speakerDurationSeconds: number;
  lastSeenAt: string;
};

export type PersonaVoiceTranscriptSummary = {
  recordCount: number;
  mixedRecordCount: number;
  segmentCount: number;
  recordingDurationSeconds: number;
  speakerDurationSeconds: number;
  classifiedSpeakerDurationSeconds: number;
  coverageRate: number;
  byClassification: Record<PersonaVoiceSpeakerClassification, PersonaVoiceClassificationStats>;
  unresolvedVoiceprints: PersonaVoiceUnresolvedVoiceprint[];
};

export type PersonaVoiceTranscriptQueryResult = {
  matchedCount: number;
  items: PersonaVoiceTranscriptView[];
  summary: PersonaVoiceTranscriptSummary;
};

export type PersonaVoiceTranscriptQuery = {
  limit?: number;
  includeArchives?: boolean;
  includeDetails?: boolean;
  speaker?: PersonaVoiceSpeakerClassification;
  from?: number | string;
  to?: number | string;
};

const SPEAKER_CLASSIFICATIONS: PersonaVoiceSpeakerClassification[] = ["user", "other", "unknown", "conflict"];

function uniqueText(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))];
}

function segmentVoiceprintIds(segment: MessageContextSpeechSegment): string[] {
  return uniqueText([
    segment.voiceprintId,
    segment.speakerClusterId
  ]);
}

function recordVoiceprintIds(record: MessageContextRecord): string[] {
  return uniqueText([
    record.voiceprintId,
    ...(record.segments ?? []).flatMap(segmentVoiceprintIds)
  ]);
}

type PersonaVoiceIdentityIndex = Map<string, Map<string, PersonaVoiceIdentity>>;

function identityIndex(roleDir: string): PersonaVoiceIdentityIndex {
  const index: PersonaVoiceIdentityIndex = new Map();
  for (const identity of listPersonaVoiceIdentities(roleDir)) {
    const host = index.get(identity.sourceHostId) ?? new Map<string, PersonaVoiceIdentity>();
    host.set(identity.voiceprintId, identity);
    index.set(identity.sourceHostId, host);
  }
  return index;
}

function evidenceFor(index: PersonaVoiceIdentityIndex, sourceHostId: string | undefined, voiceprintIds: string[]): PersonaVoiceEvidence[] {
  const host = sourceHostId ? index.get(sourceHostId) : undefined;
  return voiceprintIds.map(voiceprintId => ({ voiceprintId, identity: host?.get(voiceprintId) }));
}

function classifyEvidence(evidence: PersonaVoiceEvidence[]): PersonaVoiceSpeakerClassification {
  if (evidence.some(item => item.identity?.conflictFields?.some(field => field === "isUser" || field === "deleted"))) {
    return "conflict";
  }
  const decisions = new Set(
    evidence.flatMap(item => typeof item.identity?.isUser === "boolean" ? [item.identity.isUser] : [])
  );
  if (decisions.size > 1) return "conflict";
  if (decisions.has(true)) return "user";
  if (decisions.has(false)) return "other";
  return "unknown";
}

function recordClassification(classes: PersonaVoiceSpeakerClassification[]): PersonaVoiceRecordClassification {
  const distinct = new Set<PersonaVoiceSpeakerClassification>(classes.length > 0 ? classes : ["unknown"]);
  if (distinct.has("conflict")) return "conflict";
  if (distinct.size > 1) return "mixed";
  return [...distinct][0] ?? "unknown";
}

function segmentDuration(segment: MessageContextSpeechSegment): number {
  return Math.max(0, Number(segment.end) - Number(segment.start)) || 0;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizePersonaVoiceTranscriptViews(views: PersonaVoiceTranscriptView[]): PersonaVoiceTranscriptSummary {
  const stats = Object.fromEntries(SPEAKER_CLASSIFICATIONS.map(classification => [classification, {
    records: 0,
    segments: 0,
    speakerDurationSeconds: 0
  }])) as Record<PersonaVoiceSpeakerClassification, PersonaVoiceClassificationStats>;
  const unresolved = new Map<string, PersonaVoiceUnresolvedVoiceprint>();
  let segmentCount = 0;
  let speakerDurationSeconds = 0;
  let recordingDurationSeconds = 0;
  let mixedRecordCount = 0;

  for (const view of views) {
    if (view.personaClassification === "mixed") mixedRecordCount += 1;
    recordingDurationSeconds += Math.max(0, Number(view.record.durationSeconds) || 0);
    const entries = view.segmentViews.length > 0
      ? view.segmentViews.map(item => ({
          classification: item.classification,
          duration: segmentDuration(item.segment),
          evidence: item.evidence
        }))
      : [{
          classification: view.personaClassification === "mixed" ? "unknown" as const : view.personaClassification,
          duration: Math.max(0, Number(view.record.durationSeconds) || 0),
          evidence: view.evidence
        }];
    const recordClasses = new Set<PersonaVoiceSpeakerClassification>();
    for (const entry of entries) {
      const classification = entry.classification;
      recordClasses.add(classification);
      segmentCount += 1;
      speakerDurationSeconds += entry.duration;
      stats[classification].segments += 1;
      stats[classification].speakerDurationSeconds += entry.duration;
      if (classification !== "unknown" && classification !== "conflict") continue;
      for (const evidence of entry.evidence) {
        const key = `${view.record.sourceHostId || ""}\0${evidence.voiceprintId}`;
        const existing = unresolved.get(key);
        unresolved.set(key, {
          sourceHostId: view.record.sourceHostId,
          sourceHostName: view.record.sourceHostName,
          voiceprintId: evidence.voiceprintId,
          classification: existing?.classification === "conflict" || classification === "conflict" ? "conflict" : "unknown",
          segments: (existing?.segments ?? 0) + 1,
          speakerDurationSeconds: (existing?.speakerDurationSeconds ?? 0) + entry.duration,
          lastSeenAt: new Date(view.record.time * 1_000).toISOString()
        });
      }
    }
    for (const classification of recordClasses) stats[classification].records += 1;
  }
  for (const classification of SPEAKER_CLASSIFICATIONS) {
    stats[classification].speakerDurationSeconds = rounded(stats[classification].speakerDurationSeconds);
  }
  const classifiedSpeakerDurationSeconds = stats.user.speakerDurationSeconds + stats.other.speakerDurationSeconds;
  const classifiedSegments = stats.user.segments + stats.other.segments;
  const coverageRate = speakerDurationSeconds > 0
    ? classifiedSpeakerDurationSeconds / speakerDurationSeconds
    : segmentCount > 0 ? classifiedSegments / segmentCount : 0;
  return {
    recordCount: views.length,
    mixedRecordCount,
    segmentCount,
    recordingDurationSeconds: rounded(recordingDurationSeconds),
    speakerDurationSeconds: rounded(speakerDurationSeconds),
    classifiedSpeakerDurationSeconds: rounded(classifiedSpeakerDurationSeconds),
    coverageRate: Math.round(coverageRate * 1_000_000) / 1_000_000,
    byClassification: stats,
    unresolvedVoiceprints: [...unresolved.values()]
      .map(item => ({ ...item, speakerDurationSeconds: rounded(item.speakerDurationSeconds) }))
      .sort((left, right) => right.segments - left.segments || right.lastSeenAt.localeCompare(left.lastSeenAt))
  };
}

function isVoiceEvidenceRecord(record: MessageContextRecord): boolean {
  if (record.direction !== "inbound" || record.kind === "tts") return false;
  if (!new Set(["speech", "rabilink"]).has(record.adapter)) return false;
  return record.kind === "asr"
    || record.kind === "voice_transcript"
    || Boolean(record.channelType?.includes("audio"))
    || Boolean(record.sourceStreamId)
    || Boolean(record.voiceprintId || record.speakerId || record.segments?.length);
}

function queryTime(value: number | string | undefined, label: string): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1_000;
    throw new Error(`${label} must be an ISO timestamp or epoch seconds.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be an ISO timestamp or epoch seconds.`);
  return parsed >= 100_000_000_000 ? parsed / 1_000 : parsed;
}

function viewWithIndex(record: MessageContextRecord, index: PersonaVoiceIdentityIndex): PersonaVoiceTranscriptView {
  const evidence = evidenceFor(index, record.sourceHostId, recordVoiceprintIds(record));
  const segmentViews = (record.segments ?? []).map(segment => {
    const segmentEvidence = evidenceFor(index, record.sourceHostId, segmentVoiceprintIds(segment));
    return {
      segment,
      classification: classifyEvidence(segmentEvidence),
      evidence: segmentEvidence
    } satisfies PersonaVoiceSegmentView;
  });
  const classifications = segmentViews.length > 0
    ? segmentViews.map(item => item.classification)
    : [classifyEvidence(evidence)];
  return {
    record,
    personaClassification: recordClassification(classifications),
    evidence,
    segmentViews
  };
}

export function personaVoiceTranscriptView(
  roleDir: string,
  record: MessageContextRecord
): PersonaVoiceTranscriptView {
  return viewWithIndex(record, identityIndex(roleDir));
}

export function queryPersonaVoiceTranscriptViews(
  roleDir: string,
  query: PersonaVoiceTranscriptQuery = {}
): PersonaVoiceTranscriptQueryResult {
  const limit = Math.max(1, Math.min(5_000, Math.floor(Number(query.limit) || 200)));
  const from = queryTime(query.from, "from");
  const to = queryTime(query.to, "to");
  if (from != null && to != null && from > to) throw new Error("from must not be later than to.");
  const records = recentMessageContextItems([roleDir], {
    limit: Number.MAX_SAFE_INTEGER,
    includeArchives: query.includeArchives === true
  });
  const index = identityIndex(roleDir);
  const matched = records
    .filter(isVoiceEvidenceRecord)
    .filter(record => from == null || record.time >= from)
    .filter(record => to == null || record.time <= to)
    .map(record => viewWithIndex(record, index))
    .filter(view => !query.speaker
      || view.segmentViews.some(item => item.classification === query.speaker)
      || (view.segmentViews.length === 0 && view.personaClassification === query.speaker));
  return {
    matchedCount: matched.length,
    items: query.includeDetails === false ? [] : matched.slice(Math.max(0, matched.length - limit)),
    summary: summarizePersonaVoiceTranscriptViews(matched)
  };
}

export function listPersonaVoiceTranscriptViews(
  roleDir: string,
  query: PersonaVoiceTranscriptQuery = {}
): PersonaVoiceTranscriptView[] {
  return queryPersonaVoiceTranscriptViews(roleDir, query).items;
}
