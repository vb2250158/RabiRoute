import type { PersonaVoiceUnresolvedVoiceprint } from "./personaVoiceIdentityClient";

const EVENT_TIMESTAMP_TOLERANCE_MS = 2_000;

export type PersonaVoiceConfirmationSession = {
  status: "idle" | "waiting" | "found";
  startedAt?: number;
  candidateKeys: string[];
  baselineLastSeenAt: Record<string, number>;
};

export function personaVoiceprintEvidenceKey(sourceHostId: string | undefined, voiceprintId: string): string {
  return `${sourceHostId || "missing-host"}\u0000${voiceprintId}`;
}

export function idlePersonaVoiceConfirmation(): PersonaVoiceConfirmationSession {
  return { status: "idle", candidateKeys: [], baselineLastSeenAt: {} };
}

export function beginPersonaVoiceConfirmation(
  unresolved: PersonaVoiceUnresolvedVoiceprint[],
  startedAt = Date.now()
): PersonaVoiceConfirmationSession {
  const baselineLastSeenAt = Object.fromEntries(unresolved.flatMap(item => {
    if (!item.sourceHostId) return [];
    const lastSeenAt = Date.parse(item.lastSeenAt);
    return Number.isFinite(lastSeenAt)
      ? [[personaVoiceprintEvidenceKey(item.sourceHostId, item.voiceprintId), lastSeenAt]]
      : [];
  }));
  return { status: "waiting", startedAt, candidateKeys: [], baselineLastSeenAt };
}

export function observePersonaVoiceConfirmation(
  session: PersonaVoiceConfirmationSession,
  unresolved: PersonaVoiceUnresolvedVoiceprint[]
): PersonaVoiceConfirmationSession {
  if (session.status !== "waiting" || session.startedAt == null) return session;
  const candidateKeys = unresolved.flatMap(item => {
    if (!item.sourceHostId) return [];
    const key = personaVoiceprintEvidenceKey(item.sourceHostId, item.voiceprintId);
    const lastSeenAt = Date.parse(item.lastSeenAt);
    const baselineLastSeenAt = session.baselineLastSeenAt[key] ?? Number.NEGATIVE_INFINITY;
    if (!Number.isFinite(lastSeenAt)
      || lastSeenAt <= baselineLastSeenAt
      || lastSeenAt < session.startedAt! - EVENT_TIMESTAMP_TOLERANCE_MS) return [];
    return [key];
  });
  return candidateKeys.length > 0
    ? { ...session, status: "found", candidateKeys: [...new Set(candidateKeys)] }
    : session;
}

export function isPersonaVoiceConfirmationCandidate(
  session: PersonaVoiceConfirmationSession,
  item: PersonaVoiceUnresolvedVoiceprint
): boolean {
  return session.candidateKeys.includes(personaVoiceprintEvidenceKey(item.sourceHostId, item.voiceprintId));
}

export function orderPersonaVoiceConfirmationCandidates(
  session: PersonaVoiceConfirmationSession,
  unresolved: PersonaVoiceUnresolvedVoiceprint[]
): PersonaVoiceUnresolvedVoiceprint[] {
  return unresolved
    .map((item, index) => ({ item, index, candidate: isPersonaVoiceConfirmationCandidate(session, item) }))
    .sort((left, right) => Number(right.candidate) - Number(left.candidate) || left.index - right.index)
    .map(entry => entry.item);
}
