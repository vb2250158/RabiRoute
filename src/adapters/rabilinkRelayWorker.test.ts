import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireRabiLinkRelayWorker,
  handleWearableHealthRelayTask,
  rabiLinkRelayPayloadFromTask,
  rabiLinkRelayTaskDisposition,
  rabiLinkRelayTaskNeedsReviewWake,
  rabiLinkRelayWorkerSnapshotForTests,
  setRabiLinkRelayWorkerTestOverrides
} from "./rabilinkRelayWorker.js";
import { config } from "../config.js";
import type { ForwardRecord, ForwardRouteKind, ForwardTemplateValues } from "../routing/types.js";
import type { WebhookAdapterProfile } from "./webhookAdapter.js";

const relayProfile: WebhookAdapterProfile = {
  type: "rabilink",
  label: "RabiLink test",
  source: "rabilink",
  path: "/rabilink",
  port: 8789,
  acceptedTypes: ["rabilink"],
  routeKind: "rabilink",
  missingTextMessage: "missing"
};

const sharedOnlyProfile: WebhookAdapterProfile = {
  ...relayProfile,
  type: "webhook",
  label: "Shared lifecycle only",
  source: "webhook",
  routeKind: "voice_transcript"
};

function configureRelay(t: TestContext, enabled: boolean): void {
  const original = {
    rabiLinkRelayEnabled: config.rabiLinkRelayEnabled,
    rabiLinkRelayUrl: config.rabiLinkRelayUrl,
    rabiLinkRelayDeviceId: config.rabiLinkRelayDeviceId
  };
  Object.assign(config, {
    rabiLinkRelayEnabled: enabled,
    rabiLinkRelayUrl: enabled ? "https://relay.test" : "",
    rabiLinkRelayDeviceId: "worker-test"
  });
  t.after(() => Object.assign(config, original));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Relay worker test state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

test("disabled Relay configuration returns an idempotent empty lease", async (t) => {
  configureRelay(t, false);
  const statusPatches: Array<Record<string, unknown>> = [];
  const restore = setRabiLinkRelayWorkerTestOverrides({
    patchStatus: (_profile, patch) => { statusPatches.push(patch); }
  });
  t.after(restore);

  const lease = await acquireRabiLinkRelayWorker(sharedOnlyProfile, "/unused");
  assert.equal(lease.workerKey, "disabled:worker-test");
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);
  const firstRelease = lease.release();
  const secondRelease = lease.release();
  await Promise.all([firstRelease, secondRelease]);
  assert.deepEqual(statusPatches, [{
    relayWorker: "disabled",
    message: "RabiLink Relay worker is disabled."
  }]);
});

test("the first enabled Relay lease must use the rabilink profile", async (t) => {
  configureRelay(t, true);
  const restore = setRabiLinkRelayWorkerTestOverrides({
    patchStatus: () => undefined
  });
  t.after(restore);

  await assert.rejects(
    acquireRabiLinkRelayWorker(sharedOnlyProfile, "/webhook"),
    /first RabiLink Relay worker lease must use the rabilink profile/
  );
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);
});

test("Relay worker leases share one loop and the last release aborts all work", async (t) => {
  configureRelay(t, true);
  const eventCallbacks: Array<(eventType: string) => void> = [];
  const consumeSignals: AbortSignal[] = [];
  const claimSignals: AbortSignal[] = [];
  const handledProfiles: WebhookAdapterProfile[] = [];
  const handledSignals: AbortSignal[] = [];
  const statusPatches: Array<Record<string, unknown>> = [];
  let claimCount = 0;
  let reviewerStarts = 0;
  const restore = setRabiLinkRelayWorkerTestOverrides({
    consumeEvents: async (signal, onEvent) => {
      consumeSignals.push(signal);
      eventCallbacks.push(onEvent);
      await waitForAbort(signal);
    },
    claimTask: async (signal) => {
      claimSignals.push(signal);
      claimCount += 1;
      return claimCount === 1 ? { id: "task-one" } : null;
    },
    handleTask: async (profile, _webhookPath, _task, signal) => {
      handledProfiles.push(profile);
      handledSignals.push(signal);
    },
    patchStatus: (_profile, patch) => { statusPatches.push(patch); },
    appendLog: () => undefined,
    startReviewer: () => { reviewerStarts += 1; }
  });
  t.after(restore);

  const firstLease = await acquireRabiLinkRelayWorker(relayProfile, "/rabilink");
  const sharedLease = await acquireRabiLinkRelayWorker(sharedOnlyProfile, "/webhook");
  assert.equal(firstLease.workerKey, sharedLease.workerKey);
  assert.equal(consumeSignals.length, 1);
  assert.equal(reviewerStarts, 1);
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), [{
    workerKey: firstLease.workerKey,
    leaseCount: 2,
    aborted: false,
    profileType: "rabilink"
  }]);

  eventCallbacks[0]("ready");
  await waitFor(() => handledProfiles.length === 1 && claimCount >= 2);
  assert.equal(handledProfiles[0], relayProfile);
  assert.equal(claimSignals[0], consumeSignals[0]);
  assert.equal(handledSignals[0], consumeSignals[0]);

  await sharedLease.release();
  assert.equal(consumeSignals[0].aborted, false);
  assert.equal(rabiLinkRelayWorkerSnapshotForTests()[0].leaseCount, 1);

  const firstRelease = firstLease.release();
  const repeatedRelease = firstLease.release();
  assert.equal(firstRelease, repeatedRelease);
  await Promise.all([firstRelease, repeatedRelease]);
  assert.equal(consumeSignals[0].aborted, true);
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);

  const statusCountAfterStop = statusPatches.length;
  const claimCountAfterStop = claimCount;
  eventCallbacks[0]("task_available");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusPatches.length, statusCountAfterStop);
  assert.equal(claimCount, claimCountAfterStop);

  const replacementLease = await acquireRabiLinkRelayWorker(relayProfile, "/rabilink");
  assert.equal(replacementLease.workerKey, firstLease.workerKey);
  assert.equal(consumeSignals.length, 2);
  assert.equal(reviewerStarts, 2);
  await replacementLease.release();
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);
});

test("Relay reconnect uses one cancellable loop and passes its signal to retry waits", async (t) => {
  configureRelay(t, true);
  const consumeSignals: AbortSignal[] = [];
  const delaySignals: AbortSignal[] = [];
  let consumeCalls = 0;
  const restore = setRabiLinkRelayWorkerTestOverrides({
    consumeEvents: async (signal) => {
      consumeSignals.push(signal);
      consumeCalls += 1;
      if (consumeCalls === 1) throw new Error("stream closed");
      await waitForAbort(signal);
    },
    delay: async (_ms, signal) => {
      delaySignals.push(signal);
    },
    patchStatus: () => undefined,
    appendLog: () => undefined,
    startReviewer: () => undefined
  });
  t.after(restore);

  const lease = await acquireRabiLinkRelayWorker(relayProfile, "/rabilink");
  await waitFor(() => consumeCalls === 2);
  assert.equal(delaySignals.length, 1);
  assert.equal(delaySignals[0], consumeSignals[0]);
  assert.equal(consumeSignals[1], consumeSignals[0]);

  await lease.release();
  assert.equal(consumeSignals[0].aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consumeCalls, 2);
});

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

test("authenticated Relay tasks derive the sender account from the stable device instead of trusting claimed identity keys", () => {
  const payload = rabiLinkRelayPayloadFromTask({
    sourceDeviceId: "phone-one",
    sourceDeviceName: "Phone",
    identityNamespace: "forged:namespace",
    senderStableId: "another-user",
    sourceHostId: "speech-host",
    voiceprintId: "voice-one",
    segments: [{ speakerClusterId: "voice-two" }],
    text: "message"
  }, "relay-task-one");

  assert.equal(payload.identityNamespace, "relay:rabilink");
  assert.equal(payload.senderStableId, "phone-one");
  assert.equal(payload.sourceHostId, "speech-host");
  assert.equal(payload.voiceprintId, "voice-one");
  assert.deepEqual(payload.segments, [{ speakerClusterId: "voice-two" }]);
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
  const deliveries: Array<{ kind: ForwardRouteKind; record: ForwardRecord; extra: ForwardTemplateValues }> = [];
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
    forward: (kind: ForwardRouteKind, record: ForwardRecord, extra: ForwardTemplateValues = {}) => {
      deliveries.push({ kind, record, extra });
    }
  };
  try {
    assert.equal(handleWearableHealthRelayTask(task, task.id, options), true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "wearable_health_alert");
    assert.equal("adapterType" in deliveries[0].record ? deliveries[0].record.adapterType : undefined, "wearable");
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
  const deliveries: Array<{ kind: ForwardRouteKind; record: ForwardRecord; extra: ForwardTemplateValues }> = [];
  const options = {
    enabled: true,
    memoryDataDir: directory,
    agentRoleId: "YeYu",
    managerPort: 8790,
    appendLog: () => undefined,
    forward: (kind: ForwardRouteKind, record: ForwardRecord, extra: ForwardTemplateValues = {}) => {
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
    assert.equal("adapterType" in deliveries[0].record ? deliveries[0].record.adapterType : undefined, "wearable");
    assert.match(String(deliveries[0].record.rawMessage), /进入睡眠/);
    assert.equal(deliveries[0].extra.inputAdapter, "wearable");
    assert.equal(deliveries[0].extra.sleepState, "sleeping");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
