import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildActiveIntelligencePhysicalAcceptance } from "./check-active-intelligence-physical-acceptance.mjs";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function writeJson(root, name, payload) {
  const target = path.join(root, name);
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

function completeFixture({ generatedAt = NOW.toISOString(), synthetic = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-active-physical-"));
  const dataset = writeJson(root, "speaker-cases.json", {
    dataset_kind: synthetic ? "synthetic_tts" : "real_person_private",
    formal_validation_eligible: !synthetic,
    samples: [
      { speaker: "private-a", role: "enroll", path: "a.wav" },
      { speaker: "private-a", role: "test", path: "b.wav" },
      { speaker: "private-b", role: "test", path: "c.wav" }
    ]
  });
  const datasetHash = crypto.createHash("sha256").update(fs.readFileSync(dataset)).digest("hex");
  const report = writeJson(root, "speaker-report.json", {
    schema_version: 1,
    generated_at: Date.parse(generatedAt) / 1000,
    dataset_manifest_sha256: datasetHash,
    dataset_kind: synthetic ? "synthetic_tts" : "real_person_private",
    formal_validation_eligible: true,
    validation: { passed: true, policy_sha256: "a".repeat(64) },
    results: [{ engine: "eres2net", validation: { passed: true } }]
  });
  const persona = writeJson(root, "persona.json", {
    schemaVersion: 2,
    kind: "persona_sync_physical_acceptance",
    generatedAt,
    mode: "sync",
    syncPassed: true,
    physicalHostsConfirmed: true,
    formalAcceptanceEligible: true,
    acceptancePassed: true,
    status: "passed"
  });
  const mobile = writeJson(root, "mobile.json", {
    passed: true,
    serial: "private-device",
    packageName: "com.rabi.link",
    endedAt: generatedAt,
    observedDurationHours: 24.1,
    bytesIncreased: true
  });
  const rokid = writeJson(root, "rokid.json", {
    passed: true,
    generatedAt,
    mode: "real-device-no-injection",
    allowNoAsrText: false,
    commands: [{ command: "tts" }, { command: "asr_start" }],
    checks: { realTtsAck: true, asrTextReceived: true, noFatalException: true, nativeErrorSeen: false }
  });
  const observation = writeJson(root, "observation.json", {
    schemaVersion: 1,
    kind: "active_intelligence_physical_observation",
    generatedAt,
    operatorConfirmed: true,
    environmentIdHash: "b".repeat(64),
    checks: {
      personaSyncDistinctPhysicalHosts: true,
      personaSyncLan: true,
      personaSyncRelayFallback: true,
      personaSyncDisconnectRecovery: true,
      personaSyncConflictResolution: true,
      personaSyncLongRun: true,
      androidOfflineRecovery: true,
      androidProcessReclaimRecovery: true,
      androidBootRecovery: true,
      androidPhonePlayback: true,
      rokidContinuousPcm: true,
      rokidTouchpad: true,
      rokidPlaybackHeard: true,
      rokidConnectionRecovery: true
    }
  });
  return { root, dataset, report, persona, mobile, rokid, observation };
}

function runFixture(fixture, extra = {}) {
  return buildActiveIntelligencePhysicalAcceptance({
    speakerDataset: fixture.dataset,
    speakerReport: fixture.report,
    personaSync: fixture.persona,
    mobileSoak: fixture.mobile,
    rokid: fixture.rokid,
    observation: fixture.observation,
    outputPath: path.join(fixture.root, "aggregate.json"),
    maxAgeDays: 30,
    ...extra
  }, { now: () => NOW });
}

test("physical acceptance passes only with fresh formal and real-device evidence", () => {
  const fixture = completeFixture();
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.overall.state, "passed");
  assert.deepEqual(Object.values(result.report.domains).map(domain => domain.state), ["passed", "passed", "passed", "passed"]);
  const output = fs.readFileSync(result.outputPath, "utf8");
  assert.equal(output.includes("private-device"), false);
  assert.equal(output.includes("private-a"), false);
  assert.equal(output.includes(fixture.root), false);
});

test("physical acceptance fails closed when evidence is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-active-missing-"));
  const result = buildActiveIntelligencePhysicalAcceptance({
    speakerDataset: path.join(root, "missing-dataset.json"),
    speakerReport: path.join(root, "missing-report.json"),
    personaSync: path.join(root, "missing-persona.json"),
    mobileSoak: path.join(root, "missing-mobile.json"),
    rokid: path.join(root, "missing-rokid.json"),
    observation: path.join(root, "missing-observation.json"),
    outputPath: ""
  }, { now: () => NOW });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.overall.state, "missing");
  assert.equal(result.report.domains.voiceprint.state, "missing");
});

test("synthetic speaker evidence cannot impersonate formal validation", () => {
  const fixture = completeFixture({ synthetic: true });
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.domains.voiceprint.state, "invalid");
  assert(result.report.domains.voiceprint.issues.includes("synthetic_or_unqualified_dataset_claimed_as_formal"));
});

test("otherwise passing old evidence is reported as stale", () => {
  const fixture = completeFixture({ generatedAt: "2026-01-01T00:00:00.000Z" });
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.overall.state, "stale");
  assert.equal(result.report.domains.voiceprint.state, "stale");
  assert.equal(result.report.domains.personaSync.state, "stale");
});

test("functional persona sync without physical-host confirmation remains partial", () => {
  const fixture = completeFixture();
  const payload = JSON.parse(fs.readFileSync(fixture.persona, "utf8"));
  payload.physicalHostsConfirmed = false;
  payload.formalAcceptanceEligible = false;
  payload.acceptancePassed = false;
  fs.writeFileSync(fixture.persona, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.domains.personaSync.state, "partial");
});

test("legacy schema-one persona evidence remains partial instead of becoming formal", () => {
  const fixture = completeFixture();
  fs.writeFileSync(fixture.persona, `${JSON.stringify({
    schemaVersion: 1,
    kind: "persona_sync_physical_acceptance",
    generatedAt: NOW.toISOString(),
    mode: "sync",
    acceptancePassed: true,
    status: "passed"
  }, null, 2)}\n`, "utf8");
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.domains.personaSync.state, "partial");
});

test("observation with missing or unknown checks fails closed", () => {
  const fixture = completeFixture();
  const payload = JSON.parse(fs.readFileSync(fixture.observation, "utf8"));
  delete payload.checks.androidBootRecovery;
  payload.checks.unregisteredFact = true;
  fs.writeFileSync(fixture.observation, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = runFixture(fixture);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.domains.personaSync.state, "invalid");
  assert.equal(result.report.domains.android.state, "invalid");
  assert.equal(result.report.domains.rokid.state, "invalid");
});
