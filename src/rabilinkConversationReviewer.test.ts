import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRabiLinkConversationEntry } from "./rabilinkConversationLedger.js";
import { RabiLinkConversationReviewer } from "./rabilinkConversationReviewer.js";

const mockThread = {
  id: "thread-rabilink-review",
  threadName: "RabiLink",
  updatedAt: "2026-07-13T10:00:00.000Z",
  source: "test"
};

test("automatic conversation review waits for an idle Codex thread and then advances its cursor", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:1",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "这句话只应该先进入账本",
    routeProfileId: "Ilias",
    requiresReview: true
  });
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-agent:1",
    recordedAt: "2026-07-13T10:00:01.000Z",
    direction: "agent_to_user",
    kind: "agent_message",
    text: "这是 Agent 之前说过的话"
  });

  const prompts: string[] = [];
  let busy = true;
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    settleMs: 0,
    now: () => Date.parse("2026-07-13T10:01:00.000Z"),
    notifyWhenIdle: async (prompt) => {
      prompts.push(prompt);
      return { status: busy ? "busy" : "delivered", thread: mockThread };
    },
    notifyNow: async () => undefined
  });

  const first = await reviewer.check();
  assert.equal(first.status, "busy");
  busy = false;
  const second = await reviewer.check();
  assert.equal(second.status, "delivered");
  assert.equal(second.pendingUserCount, 1);
  assert.match(prompts.at(-1) || "", /统一会话账本/);
  assert.match(prompts.at(-1) || "", /历史会话索引/);
  assert.match(prompts.at(-1) || "", /本次涉及 Route：Ilias/);
  assert.match(prompts.at(-1) || "", /"routeProfileId":"Ilias"/);
  assert.doesNotMatch(prompts.at(-1) || "", /这句话只应该先进入账本/);
  const third = await reviewer.check();
  assert.equal(third.status, "idle");
});

test("a touchpad review request guides the current turn immediately even without new user text", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-manual-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-control:review-1",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "control",
    kind: "review_request",
    text: "用户单击触摸板要求审阅",
    reviewRequested: true
  });
  const guided: string[] = [];
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    autoReviewEnabled: false,
    settleMs: 60000,
    notifyWhenIdle: async () => ({ status: "busy", thread: mockThread }),
    notifyNow: async (prompt) => { guided.push(prompt); }
  });

  const result = await reviewer.check();
  assert.equal(result.status, "delivered");
  assert.equal(result.manual, true);
  assert.equal(guided.length, 1);
  assert.match(guided[0], /当前 turn 正在执行/);
  assert.match(guided[0], /http:\/\/127\.0\.0\.1:8790\/api\/agent\/replies/);
  assert.match(guided[0], /"routeProfileId":"RabiLink"/);
  assert.match(guided[0], /"targetType":"rabilink"/);
  assert.match(guided[0], /"proactive":true/);
  assert.match(guided[0], /ok=true 且 status=sent/);
});

test("a touchpad wake arriving during another review is checked again immediately", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-wake-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:wake-1",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "先进入自动审阅的观察",
    requiresReview: true
  });

  let releaseAutomaticReview: (() => void) | undefined;
  let resolveManualReview: (() => void) | undefined;
  const automaticBlocked = new Promise<void>((resolve) => { releaseAutomaticReview = resolve; });
  const manualDelivered = new Promise<void>((resolve) => { resolveManualReview = resolve; });
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    settleMs: 0,
    now: () => Date.parse("2026-07-13T10:01:00.000Z"),
    notifyWhenIdle: async () => {
      await automaticBlocked;
      return { status: "delivered", thread: mockThread };
    },
    notifyNow: async () => { resolveManualReview?.(); }
  });

  const first = reviewer.check();
  await Promise.resolve();
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-control:wake-review",
    recordedAt: "2026-07-13T10:00:01.000Z",
    direction: "control",
    kind: "review_request",
    text: "用户单击触摸板要求立刻审阅",
    reviewRequested: true
  });
  reviewer.wake();
  releaseAutomaticReview?.();
  await first;
  await Promise.race([
    manualDelivered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("queued touchpad wake was not handled")), 1000))
  ]);
});

test("an idle Codex thread periodically reflects on user intent even without a new transcript", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-reflection-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-agent:reflection-context",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "agent_to_user",
    kind: "agent_message",
    text: "上一次已经向用户说明了当前计划",
    proactive: true
  });
  const prompts: string[] = [];
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    autoReviewEnabled: false,
    continuousReflectionEnabled: true,
    reflectionIntervalMs: 30 * 60 * 1000,
    now: () => Date.parse("2026-07-13T10:31:00.000Z"),
    notifyWhenIdle: async (prompt) => {
      prompts.push(prompt);
      return { status: "delivered", thread: mockThread };
    },
    notifyNow: async () => undefined
  });

  const first = await reviewer.check();
  assert.equal(first.status, "delivered");
  assert.equal(first.reflection, true);
  assert.equal(first.pendingUserCount, 0);
  assert.match(prompts[0], /连续反思/);
  assert.match(prompts[0], /当前活动、真正目标、阻碍、下一步/);
  assert.match(prompts[0], /计划、任务、记忆或最近工具结果/);

  const second = await reviewer.check();
  assert.equal(second.status, "idle");
  assert.equal(prompts.length, 1);
});

test("continuous reflection can review accumulated observations when automatic review is disabled", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-reflection-pending-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:reflection-pending",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "自动审阅关闭时先保留这条观察",
    requiresReview: true
  });
  const prompts: string[] = [];
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    autoReviewEnabled: false,
    continuousReflectionEnabled: true,
    settleMs: 0,
    reflectionIntervalMs: 30 * 60 * 1000,
    now: () => Date.parse("2026-07-13T10:31:00.000Z"),
    notifyWhenIdle: async (prompt) => {
      prompts.push(prompt);
      return { status: "delivered", thread: mockThread };
    },
    notifyNow: async () => undefined
  });

  const result = await reviewer.check();
  assert.equal(result.status, "delivered");
  assert.equal(result.reflection, true);
  assert.equal(result.pendingUserCount, 1);
  assert.match(prompts[0], /本次新增用户记录：1/);
});

test("background review failures are contained and the reviewer can retry", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-background-error-"));
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:background-error",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "Codex 暂时不可用时也要保留这条观察",
    requiresReview: true
  });

  let attempt = 0;
  let resolveFailure: (() => void) | undefined;
  const failureObserved = new Promise<void>((resolve) => { resolveFailure = resolve; });
  const errors: string[] = [];
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    settleMs: 0,
    now: () => Date.parse("2026-07-13T10:01:00.000Z"),
    notifyWhenIdle: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("simulated Codex app-server timeout");
      return { status: "delivered", thread: mockThread };
    },
    notifyNow: async () => undefined,
    onBackgroundError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      resolveFailure?.();
    }
  });

  reviewer.start();
  await Promise.race([
    failureObserved,
    new Promise((_, reject) => setTimeout(() => reject(new Error("background failure was not contained")), 1000))
  ]);
  reviewer.stop();

  assert.deepEqual(errors, ["simulated Codex app-server timeout"]);
  const retry = await reviewer.check();
  assert.equal(retry.status, "delivered");
  assert.equal(attempt, 2);
});

test("unreviewed observations remain pending after the ledger rotates", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-rotated-pending-"));
  const splitAfterMs = 2 * 60 * 60 * 1000;
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:before-rotation",
    recordedAt: "2026-07-13T08:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "这条观察在 Codex 恢复前被分卷",
    requiresReview: true
  }, { splitAfterMs });
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:after-rotation",
    recordedAt: "2026-07-13T11:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "这是新分卷里的观察",
    requiresReview: true
  }, { splitAfterMs });

  const prompts: string[] = [];
  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    settleMs: 0,
    now: () => Date.parse("2026-07-13T11:01:00.000Z"),
    notifyWhenIdle: async (prompt) => {
      prompts.push(prompt);
      return { status: "delivered", thread: mockThread };
    },
    notifyNow: async () => undefined
  });

  const result = await reviewer.check();
  assert.equal(result.status, "delivered");
  assert.equal(result.pendingUserCount, 2);
  assert.match(prompts[0], /本次新增用户记录：2/);
  assert.match(prompts[0], /rabilink-user:before-rotation -> rabilink-user:after-rotation/);
});

test("conversation review state replaces a corrupt cursor atomically", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-reviewer-state-"));
  const statePath = path.join(dataDir, "rabilink-conversation-review-state.json");
  fs.writeFileSync(statePath, "{incomplete", "utf8");
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:state-recovery",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "损坏的审阅游标不能丢掉待审阅观察",
    requiresReview: true
  });

  const reviewer = new RabiLinkConversationReviewer({
    dataDir,
    routeProfileId: "RabiLink",
    gatewayManagerUrl: "http://127.0.0.1:8790",
    settleMs: 0,
    now: () => Date.parse("2026-07-13T10:01:00.000Z"),
    notifyWhenIdle: async () => ({ status: "delivered", thread: mockThread }),
    notifyNow: async () => undefined
  });

  const result = await reviewer.check();
  assert.equal(result.status, "delivered");
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
    schemaVersion: 1,
    lastScheduledUserEntryId: "rabilink-user:state-recovery",
    lastScheduledAt: "2026-07-13T10:01:00.000Z"
  });
  assert.equal(
    fs.readdirSync(dataDir).some((file) => file.startsWith("rabilink-conversation-review-state.json.") && file.endsWith(".tmp")),
    false,
    "review cursor replacement must not leave temporary files behind"
  );
  assert.equal((await reviewer.check()).status, "idle");
});
