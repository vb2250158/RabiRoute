import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  currentWearableHealthState,
  ingestWearableHealthObservation,
  queryWearableHealthHistory,
  readWearableHealthConfig,
  summarizeWearableHealth,
  wearableHealthEventsDir
} from "./wearableHealth.js";

function withRoleDir(run: (roleDir: string) => void): void {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wearable-health-"));
  try {
    run(roleDir);
  } finally {
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
}

test("records heart-rate samples, deduplicates retries, and respects alert cooldown", () => {
  withRoleDir((roleDir) => {
    const first = ingestWearableHealthObservation(roleDir, {
      eventId: "event-1",
      capturedAt: "2026-07-18T10:00:00.000Z",
      source: "health-connect",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceName: "Xiaomi Smart Band 10 Pro",
      sourceDeviceKind: "band",
      transport: "phone-companion",
      policy: {
        heartRateHighBpm: 120,
        heartRateAlertCooldownMinutes: 15
      },
      samples: [{ id: "hr-1", metric: "heart_rate", time: "2026-07-18T10:00:00.000Z", bpm: 132 }]
    }, { now: Date.parse("2026-07-18T10:00:01.000Z") });

    assert.equal(first.accepted.length, 1);
    assert.equal(first.alerts.length, 1);
    assert.equal(first.alerts[0]?.type, "heart_rate_high");
    assert.match(first.alerts[0]?.message ?? "", /132 bpm/);

    const retry = ingestWearableHealthObservation(roleDir, {
      eventId: "event-1-retry",
      capturedAt: "2026-07-18T10:00:02.000Z",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceKind: "band",
      samples: [{ id: "hr-1", metric: "heart_rate", time: "2026-07-18T10:00:00.000Z", bpm: 132 }]
    }, { now: Date.parse("2026-07-18T10:00:02.000Z") });

    assert.equal(retry.accepted.length, 0);
    assert.equal(retry.deduplicated.length, 1);
    assert.equal(retry.alerts.length, 0);

    const duringCooldown = ingestWearableHealthObservation(roleDir, {
      eventId: "event-2",
      capturedAt: "2026-07-18T10:05:00.000Z",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceKind: "band",
      samples: [{ id: "hr-2", metric: "heart_rate", time: "2026-07-18T10:05:00.000Z", bpm: 138 }]
    }, { now: Date.parse("2026-07-18T10:05:00.000Z") });

    assert.equal(duringCooldown.accepted.length, 1);
    assert.equal(duringCooldown.alerts.length, 0);
    const history = queryWearableHealthHistory(roleDir, { metrics: ["heart_rate"], order: "asc" });
    assert.deepEqual(history.map((sample) => sample.value), [132, 138]);
    const summary = summarizeWearableHealth(roleDir, {
      from: "2026-07-18T09:00:00.000Z",
      to: "2026-07-18T10:06:00.000Z"
    });
    assert.equal(summary.heartRate.count, 2);
    assert.equal(summary.heartRate.min, 132);
    assert.equal(summary.heartRate.max, 138);
    assert.equal(summary.heartRate.average, 135);
  });
});

test("tracks sleep transitions and exposes current sleep state", () => {
  withRoleDir((roleDir) => {
    ingestWearableHealthObservation(roleDir, {
      eventId: "sleep-1",
      capturedAt: "2026-07-18T22:00:00.000Z",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceKind: "band",
      policy: { sleepStateAlertEnabled: true, sleepStateStaleAfterMinutes: 600 },
      samples: [{ id: "sleep-state-1", metric: "sleep_state", time: "2026-07-18T22:00:00.000Z", state: "sleeping" }]
    }, { now: Date.parse("2026-07-18T22:00:00.000Z") });

    const wake = ingestWearableHealthObservation(roleDir, {
      eventId: "sleep-2",
      capturedAt: "2026-07-19T06:30:00.000Z",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceKind: "band",
      samples: [
        {
          id: "sleep-session-1",
          metric: "sleep_session",
          startAt: "2026-07-18T22:00:00.000Z",
          endAt: "2026-07-19T06:30:00.000Z"
        },
        { id: "sleep-state-2", metric: "sleep_state", time: "2026-07-19T06:30:00.000Z", state: "awake" }
      ]
    }, { now: Date.parse("2026-07-19T06:30:00.000Z") });

    assert.equal(wake.alerts.length, 1);
    assert.equal(wake.alerts[0]?.type, "sleep_state_changed");
    const state = currentWearableHealthState(roleDir, "mi-band-10-pro", Date.parse("2026-07-19T06:31:00.000Z"));
    assert.equal(state.sleepState, "awake");
    assert.equal(state.sleepStateStale, false);
    assert.equal(state.latestSleepSession?.id, "sleep-session-1");
  });
});

test("keeps secrets out of wearable health history", () => {
  withRoleDir((roleDir) => {
    const secret = "0123456789abcdef0123456789abcdef";
    ingestWearableHealthObservation(roleDir, {
      eventId: "secret-check",
      sourceDeviceId: "mi-band-10-pro",
      sourceDeviceKind: "band",
      samples: [{
        id: "hr-secret",
        metric: "heart_rate",
        time: "2026-07-18T10:00:00.000Z",
        bpm: 80,
        metadata: { authKey: secret, provider: "health-connect" }
      }]
    });

    const files = fs.readdirSync(wearableHealthEventsDir(roleDir)).map((name) => path.join(wearableHealthEventsDir(roleDir), name));
    const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.equal(text.includes(secret), false);
    assert.match(text, /health-connect/);
    assert.equal(readWearableHealthConfig(roleDir).devices["mi-band-10-pro"]?.sourceDeviceKind, "band");
  });
});
