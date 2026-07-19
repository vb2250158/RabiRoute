import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWearableHealthAlertRecord,
  wearableHealthAlertTemplateValues
} from "./wearableHealthAlertDelivery.js";
import type { WearableHealthAlert } from "./wearableHealth.js";

test("wearable health alert delivery targets the configured role without leaking policy data", () => {
  const alert: WearableHealthAlert = {
    id: "health-alert-1",
    type: "heart_rate_high",
    severity: "warning",
    message: "心率过快：135 bpm。",
    ruleKey: "watch-1:heart-rate-high",
    createdAt: "2026-07-18T12:00:00.000Z",
    sample: {
      schemaVersion: 1,
      id: "heart-1",
      eventId: "health-event-1",
      metric: "heart_rate",
      recordedAt: "2026-07-18T12:00:00.000Z",
      startAt: "2026-07-18T12:00:00.000Z",
      value: 135,
      unit: "bpm",
      source: "xiaomi-health-adb-provider",
      sourceDeviceId: "watch-1",
      sourceDeviceKind: "band",
      transport: "manager-local"
    }
  };

  const record = buildWearableHealthAlertRecord(alert, {
    agentRoleId: "YeYu",
    managerPort: 8790,
    sourceDeviceId: "watch-1",
    sourceDeviceName: "Test Band",
    sourceDeviceKind: "band",
    transport: "manager-local"
  });
  assert.equal(record.routeProfileId, "YeYu");
  assert.equal(record.adapterType, "wearable");
  assert.match(record.rawMessage, /135 bpm/);
  assert.match(record.rawMessage, /\/api\/roles\/YeYu\/health\/history/);
  assert.deepEqual(wearableHealthAlertTemplateValues(alert), {
    inputAdapter: "wearable",
    healthAlertType: "heart_rate_high",
    healthMetric: "heart_rate",
    heartRateBpm: 135,
    sleepState: undefined,
    sourceDeviceId: "watch-1"
  });
});
