import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MessageGroupingQueue,
  messageFragmentLooksIncomplete,
  type PendingMessageGroup
} from "./messageGrouping.js";

function input(identity: string, text: string, patch: Record<string, unknown> = {}) {
  return {
    key: "napcat|group:100|user:200|reply:none",
    baseKey: "napcat|group:100|user:200",
    endpoint: "napcat",
    conversationKey: "napcat:group:100",
    sender: "200",
    identity,
    text,
    policy: {
      enabled: true,
      settleSeconds: 6,
      incompleteSettleSeconds: 12,
      maxWaitSeconds: 20
    },
    payload: {
      routeKind: "group_message",
      record: { messageId: identity, rawMessage: text, groupId: 100, userId: 200, ...patch },
      extraValues: {}
    }
  };
}

test("unfinished conversational fragments receive the longer wait", () => {
  assert.equal(messageFragmentLooksIncomplete("这个"), true);
  assert.equal(messageFragmentLooksIncomplete("还有，"), true);
  assert.equal(messageFragmentLooksIncomplete("按钮往下挪一点。"), false);
});

test("message grouping batches fragments, extends the deadline, and deduplicates message ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-groups-"));
  let now = 1_000;
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const queue = new MessageGroupingQueue(path.join(root, "pending.json"), async () => undefined, {
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle) => { (handle as unknown as { cancelled: boolean }).cancelled = true; }
  });

  const first = queue.enqueue(input("m1", "这个"));
  assert.equal(first.accepted, true);
  assert.equal(scheduled.at(-1)?.delayMs, 12_000);
  now = 5_000;
  const second = queue.enqueue(input("m2", "按钮往下挪一点。"));
  assert.equal(second.groupId, first.groupId);
  assert.equal(second.itemCount, 2);
  assert.equal(scheduled.at(-1)?.delayMs, 6_000);
  assert.equal(queue.enqueue(input("m2", "重复")).accepted, false);
  assert.equal(queue.snapshot().pending[0]?.deadlineAt, 11_000);
  queue.close();
});

test("pending groups recover after restart and successful delivery persists dedupe evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-groups-recover-"));
  const statePath = path.join(root, "pending.json");
  let now = 10_000;
  const first = new MessageGroupingQueue(statePath, async () => undefined, {
    now: () => now,
    schedule: (() => ({}) as ReturnType<typeof setTimeout>),
    cancel: () => undefined
  });
  first.enqueue(input("recover-1", "半句话"));
  first.close();

  const delivered: PendingMessageGroup[] = [];
  const recovered = new MessageGroupingQueue(statePath, async (group) => { delivered.push(group); }, {
    now: () => now,
    schedule: (() => ({}) as ReturnType<typeof setTimeout>),
    cancel: () => undefined
  });
  assert.equal(recovered.snapshot().pending.length, 1);
  assert.equal(await recovered.flushNow(recovered.snapshot().pending[0]!.key), true);
  assert.equal(delivered[0]?.items[0]?.identity, "recover-1");
  assert.equal(recovered.enqueue(input("recover-1", "重复回放")).accepted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).pending, []);
  recovered.close();
});

test("recovered state normalizes incomplete runtime fields before scheduling and retrying", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-groups-normalize-"));
  const statePath = path.join(root, "pending.json");
  const legacy = input("legacy-1", "旧状态。", {});
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "invalid-but-optional",
    pending: [{
      groupId: "legacy-group",
      key: legacy.key,
      baseKey: legacy.baseKey,
      endpoint: legacy.endpoint,
      conversationKey: legacy.conversationKey,
      sender: legacy.sender,
      createdAt: 1_000,
      deadlineAt: 7_000,
      items: [{
        identity: legacy.identity,
        receivedAt: 1_000,
        payload: legacy.payload
      }]
    }],
    deliveredIdentities: []
  }), "utf8");
  const delays: number[] = [];
  const queue = new MessageGroupingQueue(statePath, async () => {
    throw new Error("retry safely");
  }, {
    now: () => 2_000,
    schedule: (_callback, delayMs) => {
      delays.push(delayMs);
      return {} as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined
  });

  const recovered = queue.snapshot().pending[0]!;
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.attempts, 0);
  assert.equal(recovered.maxDeadlineAt, 7_000);
  assert.equal(recovered.items[0]?.incomplete, false);
  assert.equal(delays[0], 5_000);
  assert.equal(await queue.flushNow(recovered.key), false);
  assert.equal(queue.snapshot().pending[0]?.attempts, 1);
  assert.equal(delays.at(-1), 5_000);
  queue.close();
});

test("failed delivery retains the complete group and schedules a retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-groups-retry-"));
  let now = 20_000;
  const delays: number[] = [];
  const queue = new MessageGroupingQueue(path.join(root, "pending.json"), async () => {
    throw new Error("Desktop owner unavailable");
  }, {
    now: () => now,
    schedule: (_callback, delayMs) => {
      delays.push(delayMs);
      return {} as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined
  });
  queue.enqueue(input("retry-1", "完整消息。"));
  const key = queue.snapshot().pending[0]!.key;
  assert.equal(await queue.flushNow(key), false);
  const pending = queue.snapshot().pending[0]!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempts, 1);
  assert.equal(pending.lastError, "Desktop owner unavailable");
  assert.equal(delays.at(-1), 5_000);
  queue.close();
});

test("a fragment arriving during delivery stays queued and is delivered as a same-group supplement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-groups-inflight-"));
  let releaseFirst!: () => void;
  const firstDeliveryGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const delivered: string[][] = [];
  const queue = new MessageGroupingQueue(path.join(root, "pending.json"), async (group) => {
    delivered.push(group.items.map((item) => item.identity));
    if (delivered.length === 1) await firstDeliveryGate;
  }, {
    schedule: (() => ({}) as ReturnType<typeof setTimeout>),
    cancel: () => undefined
  });
  const first = queue.enqueue(input("during-1", "第一段。"));
  const firstFlush = queue.flushNow(queue.snapshot().pending[0]!.key);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const supplement = queue.enqueue(input("during-2", "交付期间的新补充。"));
  assert.equal(supplement.groupId, first.groupId);
  assert.equal(queue.snapshot().pending[0]?.status, "delivering");
  releaseFirst();
  assert.equal(await firstFlush, true);

  const remaining = queue.snapshot().pending[0]!;
  assert.equal(remaining.groupId, first.groupId);
  assert.deepEqual(remaining.items.map((item) => item.identity), ["during-2"]);
  assert.equal(remaining.status, "pending");
  assert.equal(await queue.flushNow(remaining.key), true);
  assert.deepEqual(delivered, [["during-1"], ["during-2"]]);
  assert.equal(queue.snapshot().pending.length, 0);
  queue.close();
});
