import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPersonaVoiceConfirmation,
  idlePersonaVoiceConfirmation,
  isPersonaVoiceConfirmationCandidate,
  observePersonaVoiceConfirmation,
  orderPersonaVoiceConfirmationCandidates
} from "../src/persona/personaVoiceConfirmation";
import type { PersonaVoiceUnresolvedVoiceprint } from "../src/persona/personaVoiceIdentityClient";

function unresolved(
  voiceprintId: string,
  lastSeenAt: string,
  sourceHostId: string | null = "host-one"
): PersonaVoiceUnresolvedVoiceprint {
  return {
    sourceHostId: sourceHostId ?? undefined,
    voiceprintId,
    classification: "unknown",
    segments: 1,
    speakerDurationSeconds: 3,
    lastSeenAt
  };
}

test("voice confirmation highlights only an actionable voiceprint observed after the user starts", () => {
  const startedAt = Date.parse("2026-07-24T10:00:00.000Z");
  const oldVoice = unresolved("old", "2026-07-24T09:59:00.000Z");
  const newVoice = unresolved("new", "2026-07-24T10:00:05.000Z");
  const legacyWithoutHost = unresolved("legacy", "2026-07-24T10:00:06.000Z", null);

  const waiting = observePersonaVoiceConfirmation(
    beginPersonaVoiceConfirmation([oldVoice, legacyWithoutHost], startedAt),
    [oldVoice]
  );
  assert.equal(waiting.status, "waiting");

  const found = observePersonaVoiceConfirmation(waiting, [oldVoice, legacyWithoutHost, newVoice]);
  assert.equal(found.status, "found");
  assert.equal(isPersonaVoiceConfirmationCandidate(found, oldVoice), false);
  assert.equal(isPersonaVoiceConfirmationCandidate(found, legacyWithoutHost), false);
  assert.equal(isPersonaVoiceConfirmationCandidate(found, newVoice), true);
  assert.deepEqual(orderPersonaVoiceConfirmationCandidates(found, [oldVoice, newVoice]), [newVoice, oldVoice]);
});

test("voice confirmation remains presentation-only and keeps captured candidates until cancelled", () => {
  const candidate = unresolved("new", "2026-07-24T10:00:05.000Z");
  const found = observePersonaVoiceConfirmation(
    beginPersonaVoiceConfirmation([], Date.parse("2026-07-24T10:00:00.000Z")),
    [candidate]
  );
  const afterLaterRefresh = observePersonaVoiceConfirmation(found, []);

  assert.deepEqual(afterLaterRefresh, found);
  assert.deepEqual(idlePersonaVoiceConfirmation(), { status: "idle", candidateKeys: [], baselineLastSeenAt: {} });
  assert.equal("isUser" in afterLaterRefresh, false);
});

test("voice confirmation detects a previously unresolved voiceprint only after its last-seen value advances", () => {
  const before = unresolved("same-voice", "2026-07-24T09:55:00.000Z");
  const unchanged = unresolved("same-voice", "2026-07-24T09:55:00.000Z");
  const after = unresolved("same-voice", "2026-07-24T10:00:04.000Z");
  const session = beginPersonaVoiceConfirmation([before], Date.parse("2026-07-24T10:00:00.000Z"));

  assert.equal(observePersonaVoiceConfirmation(session, [unchanged]).status, "waiting");
  const found = observePersonaVoiceConfirmation(session, [after]);
  assert.equal(found.status, "found");
  assert.equal(isPersonaVoiceConfirmationCandidate(found, after), true);
});
