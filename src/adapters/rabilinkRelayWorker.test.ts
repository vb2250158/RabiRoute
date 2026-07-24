import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleWearableHealthRelayTask,
  rabiLinkRelayTaskDisposition,
  rabiLinkRelayTaskNeedsReviewWake
} from "./rabilinkRelayWorker.js";

test("RabiLink observations are record-only while explicit messages remain direct", () => {
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.observation",
    deliveryMode: "observe",
    text: "ambient transcript"
  }), "record_only");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink",
    deliveryMode: "observe",
    text: "record this without delivering it"
  }), "record_only");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink",
    text: "explicit direct input"
  }), "direct");
});

test("only review-owned RabiLink events wake the conversation reviewer", () => {
  assert.equal(rabiLinkRelayTaskNeedsReviewWake("record_only"), true);
  assert.equal(rabiLinkRelayTaskNeedsReviewWake("review_request"), true);
  assert.equal(rabiLinkRelayTaskNeedsReviewWake("direct"), false);
});

test("RabiLink touchpad review requests wake the reviewer without becoming direct input", () => {
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.review_request",
    deliveryMode: "observe",
    reviewRequested: true
  }), "review_request");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.observation",
    deliveryMode: "observe",
    reviewRequested: true
  }), "review_request");
});

test("wearable heart-rate thresholds create one Agent delivery and deduplicate retries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-worker-health-"));
  const deliveries: Array<{ kind: string; record: Record<string, unknown>; extra: Record<string, unknown> }> = [];
  const recordedAt = new Date().toISOString();
  const task = {
    id: "relay-health-task-1",
    clientMessageId: "health-message-1",
    type: "wearable.health",
    deliveryMode: "observe",
    sourceDeviceId: "watch-test",
    sourceDeviceName: "Test Watch",
    sourceDeviceKind: "watch",
    transport: "phone-companion",
    capturedAt: Date.now(),
    health: {
      policy: { heartRateHighBpm: 120, heartRateAlertCooldownMinutes: 15 },
      samples: [{
        id: "heart-rate-135",
        metric: "heart_rate",
        recordedAt,
        value: 135,
        unit: "bpm"
      }]
    }
  };
  const options = {
    enabled: true,
    memoryDataDir: directory,
    agentRoleId: "YeYu",
    managerPort: 8790,
    appendLog: () => undefined,
    forward: (kind: string, record: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      deliveries.push({ kind, record, extra });
    }
  };
  try {
    assert.equal(handleWearableHealthRelayTask(task, task.id, options), true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "wearable_health_alert");
    assert.equal(deliveries[0].record.adapterType, "wearable");
    assert.match(String(deliveries[0].record.rawMessage), /135 bpm/);
    assert.equal(deliveries[0].extra.inputAdapter, "wearable");
    assert.equal(deliveries[0].extra.heartRateBpm, 135);

    assert.equal(handleWearableHealthRelayTask(task, task.id, options), true);
    assert.equal(deliveries.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("wearable sleep-state changes are recorded and delivered to the Agent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-worker-sleep-"));
  const deliveries: Array<{ kind: string; record: Record<string, unknown>; extra: Record<string, unknown> }> = [];
  const options = {
    enabled: true,
    memoryDataDir: directory,
    agentRoleId: "YeYu",
    managerPort: 8790,
    appendLog: () => undefined,
    forward: (kind: string, record: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      deliveries.push({ kind, record, extra });
    }
  };
  const baseTask = {
    type: "wearable.health",
    deliveryMode: "observe",
    sourceDeviceId: "watch-sleep-test",
    sourceDeviceName: "Sleep Test Watch",
    sourceDeviceKind: "watch",
    transport: "phone-companion",
    health: {
      policy: { sleepStateAlertEnabled: true, sleepStateStaleAfterMinutes: 180 },
      samples: [] as Array<Record<string, unknown>>
    }
  };
  const awakeAt = new Date(Date.now() - 60_000).toISOString();
  const sleepingAt = new Date().toISOString();
  try {
    const awakeTask = {
      ...baseTask,
      id: "relay-sleep-task-awake",
      clientMessageId: "sleep-message-awake",
      capturedAt: Date.parse(awakeAt),
      health: {
        ...baseTask.health,
        samples: [{ id: "sleep-state-awake", metric: "sleep_state", recordedAt: awakeAt, sleepState: "awake" }]
      }
    };
    assert.equal(handleWearableHealthRelayTask(awakeTask, awakeTask.id, options), true);
    assert.equal(deliveries.length, 0);

    const sleepingTask = {
      ...baseTask,
      id: "relay-sleep-task-sleeping",
      clientMessageId: "sleep-message-sleeping",
      capturedAt: Date.parse(sleepingAt),
      health: {
        ...baseTask.health,
        samples: [{ id: "sleep-state-sleeping", metric: "sleep_state", recordedAt: sleepingAt, sleepState: "sleeping" }]
      }
    };
    assert.equal(handleWearableHealthRelayTask(sleepingTask, sleepingTask.id, options), true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "wearable_health_alert");
    assert.equal(deliveries[0].record.adapterType, "wearable");
    assert.match(String(deliveries[0].record.rawMessage), /进入睡眠/);
    assert.equal(deliveries[0].extra.inputAdapter, "wearable");
    assert.equal(deliveries[0].extra.sleepState, "sleeping");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
