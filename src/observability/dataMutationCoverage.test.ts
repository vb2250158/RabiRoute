import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateIdentityRelation } from "../identityRelations.js";
import { updatePersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import { SpeechIngressStore } from "../speechIngressStore.js";
import { ingestWearableHealthObservation } from "../wearableHealth.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "./dataMutationAudit.js";

test("formal data owners emit payload-free mutation audit records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-mutation-audit-"));
  const roleDir = path.join(root, "roles", "Rabi");
  const privateMarker = "PRIVATE-PAYLOAD-MUST-NOT-ENTER-AUDIT";
  const records: RecordedDataMutationAudit[] = [];
  const uninstall = installDataMutationAuditSink(record => records.push(record));
  try {
    updateIdentityRelation(roleDir, {
      kind: "participant",
      participantId: "participant-one",
      participantKind: "person",
      displayName: privateMarker,
      aliases: [],
      speakingHabits: [],
      status: "candidate",
      evidenceRefs: []
    });
    updatePersonaVoiceIdentity(roleDir, {
      sourceHostId: "host-one",
      voiceprintId: "voiceprint-one",
      displayName: privateMarker,
      aliases: []
    });
    new SpeechIngressStore(path.join(root, "speech")).append({
      recordId: "speech-one",
      text: privateMarker,
      recordedAt: "2026-09-04T01:02:03.000Z",
      segments: []
    });
    ingestWearableHealthObservation(roleDir, {
      eventId: "health-one",
      sourceDeviceId: "device-one",
      samples: [{ id: "sample-one", metric: "heart_rate", bpm: 137, metadata: { note: privateMarker } }]
    }, { now: Date.parse("2026-09-04T01:02:03.000Z") });
    atomicWriteFileSync(path.join(root, "state", "snapshot.json"), JSON.stringify({ privateMarker }));

    const events = new Set(records.map(record => record.event));
    assert.equal(events.has("identity_relation_appended"), true);
    assert.equal(events.has("voice_identity_appended"), true);
    assert.equal(events.has("speech_ingress_appended"), true);
    assert.equal(events.has("wearable_health_samples_appended"), true);
    assert.equal(events.has("wearable_health_state_written"), true);
    assert.equal(events.has("atomic_file_replaced"), true);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(privateMarker));
  } finally {
    uninstall();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
