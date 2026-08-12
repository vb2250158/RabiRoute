import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { config, type RouteProfile } from "./config.js";
import { deliverPacketToPrimaryAgentAdapter, forwardMessage, forwardMessageAndWait, memoryConsolidationAgentHandles, resetMessageProcessingRuntime, routeKindUsesAutomaticMessageGrouping, shouldSkipHeartbeatDelivery } from "./forwarding.js";
import type { GroupMessageRecord, HeartbeatEventRecord, PlanFeedbackMessageRecord, VoiceTranscriptEventRecord } from "./history.js";
import { ManagerSpeechControl } from "./manager/speechControl.js";
import { handleAgentReply } from "./outbox.js";
import { resolvePipeline } from "./pipelines.js";
import { readDeliveryReplayAttempts } from "./deliveryReplayLedger.js";
import { listIdentityEndpointAccounts, listIdentityParticipants } from "./identityRelations.js";
import { replayDeliveryAttempts } from "./deliveryReplay.js";
import { createSpeechIngressForwarding } from "./routing/speechIngressForwarding.js";
import { SpeechIngressStore } from "./speechIngressStore.js";
import type { PendingMessageGroup } from "./messageGrouping.js";

type ForwardingConfigPatch = Partial<Pick<typeof config,
  "agentAdapters"
  | "primaryAgentAdapter"
  | "agentRoleFile"
  | "agentRoleId"
  | "dataDir"
  | "heartbeatSkipWhenAgentBusy"
  | "messageProcessingAgents"
  | "messageAdapterPolicies"
  | "memoryDataDir"
  | "routeProfiles"
  | "rolesDir"
  | "codexThreadId"
  | "codexThreadName"
  | "codexCwd"
  | "codexMemoryConsolidationAgentEnabled"
  | "codexMemoryConsolidationAgentModel"
>>;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-forwarding-"));
}

function groupMessage(patch: Partial<GroupMessageRecord> = {}): GroupMessageRecord {
  return {
    time: 1710000000,
    groupId: 10001,
    userId: 42,
    rawMessage: "[CQ:at,qq=12345] hello",
    messageId: "msg-1",
    senderName: "Alice",
    ...patch
  };
}

function routeProfile(root: string, patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "main",
    name: "Main route",
    enabled: true,
    recentMessageLimit: 10,
    resolvedPipeline: resolvePipeline("qq_chat"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.join(root, "roles"),
    dataDir: path.join(root, "route-data"),
    routeVariables: {},
    notificationRules: [],
    ...patch
  };
}

test("heartbeat busy guard only skips active Codex heartbeat delivery", () => {
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["codex"], true), true);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["codex"], true, true), false);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", false, ["codex"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("private", true, ["codex"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["copilotCli"], true), false);
  assert.equal(shouldSkipHeartbeatDelivery("heartbeat", true, ["codex"], false), false);
});

test("chat routes group automatically while ASR and structured events stay direct", () => {
  assert.equal(routeKindUsesAutomaticMessageGrouping("group_message"), true);
  assert.equal(routeKindUsesAutomaticMessageGrouping("private"), true);
  assert.equal(routeKindUsesAutomaticMessageGrouping("weixin_message"), true);
  assert.equal(routeKindUsesAutomaticMessageGrouping("voice_transcript"), false);
  assert.equal(routeKindUsesAutomaticMessageGrouping("heartbeat"), false);
  assert.equal(routeKindUsesAutomaticMessageGrouping("wearable_health_alert"), false);
});

test("the dedicated memory Agent handles only the exact Codex consolidation trigger", () => {
  assert.equal(memoryConsolidationAgentHandles("manual_trigger", "memory-consolidation", true, "codex"), true);
  assert.equal(memoryConsolidationAgentHandles("manual_trigger", "memory-consolidation", false, "codex"), false);
  assert.equal(memoryConsolidationAgentHandles("manual_trigger", "another-trigger", true, "codex"), false);
  assert.equal(memoryConsolidationAgentHandles("heartbeat", "memory-consolidation", true, "codex"), false);
  assert.equal(memoryConsolidationAgentHandles("manual_trigger", "memory-consolidation", true, "copilotCli"), false);
});

test("AgentPacket delivery targets only the configured primary Agent", async () => {
  const dispatched: AgentAdapterType[] = [];
  await withForwardingConfig({
    agentAdapters: ["codex", "copilotCli"],
    primaryAgentAdapter: "copilotCli"
  }, async () => {
    const outcomes = await deliverPacketToPrimaryAgentAdapter(
      "main",
      "direct",
      "hello",
      async (adapter) => { dispatched.push(adapter); }
    );
    assert.deepEqual(dispatched, ["copilotCli"]);
    assert.deepEqual(outcomes, [{
      routeId: "main",
      ruleId: "direct",
      adapter: "copilotCli",
      status: "delivered"
    }]);
  });
});

test("primary Agent delivery reports a failure without trying another Agent", async () => {
  const dispatched: AgentAdapterType[] = [];
  await withForwardingConfig({
    agentAdapters: ["codex", "copilotCli"],
    primaryAgentAdapter: "copilotCli"
  }, async () => {
    const outcomes = await deliverPacketToPrimaryAgentAdapter(
      "main",
      "direct",
      "hello",
      async (adapter) => {
        dispatched.push(adapter);
        throw new Error("primary unavailable");
      }
    );
    assert.deepEqual(dispatched, ["copilotCli"]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "failed");
    assert.match(outcomes[0].error ?? "", /primary unavailable/);
  });
});

async function withForwardingConfig<T>(patch: ForwardingConfigPatch, run: () => Promise<T> | T): Promise<T> {
  const previous: ForwardingConfigPatch = {
    agentAdapters: config.agentAdapters,
    primaryAgentAdapter: config.primaryAgentAdapter,
    agentRoleFile: config.agentRoleFile,
    agentRoleId: config.agentRoleId,
    dataDir: config.dataDir,
    heartbeatSkipWhenAgentBusy: config.heartbeatSkipWhenAgentBusy,
    messageProcessingAgents: config.messageProcessingAgents,
    messageAdapterPolicies: config.messageAdapterPolicies,
    memoryDataDir: config.memoryDataDir,
    routeProfiles: config.routeProfiles,
    rolesDir: config.rolesDir,
    codexThreadId: config.codexThreadId,
    codexThreadName: config.codexThreadName,
    codexCwd: config.codexCwd,
    codexMemoryConsolidationAgentEnabled: config.codexMemoryConsolidationAgentEnabled,
    codexMemoryConsolidationAgentModel: config.codexMemoryConsolidationAgentModel
  };
  const effectivePatch = patch.agentAdapters !== undefined && !("primaryAgentAdapter" in patch)
    ? { ...patch, primaryAgentAdapter: patch.agentAdapters[0] }
    : patch;
  Object.assign(config, effectivePatch);
  try {
    return await run();
  } finally {
    resetMessageProcessingRuntime();
    Object.assign(config, previous);
  }
}

test("a grouped packet is delivered to a dynamically resolved Luna Message Agent instead of the primary Agent", async () => {
  const root = tempDir();
  const requests: Array<Record<string, any>> = [];
  const manager = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      if (body.action === "resolve") {
        response.end(JSON.stringify({ thread: { id: "019f0000-0000-7000-8000-000000000099", title: body.title, cwd: root } }));
      } else if (body.action === "read") {
        response.end(JSON.stringify({ thread: { status: { type: "idle" }, active: false } }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(0, "127.0.0.1", resolve);
  });
  const address = manager.address();
  assert.ok(address && typeof address === "object");
  const oldManagerUrl = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
  resetMessageProcessingRuntime();

  const route = routeProfile(root, {
    notificationRules: [{
      id: "group",
      name: "group",
      enabled: true,
      routeKinds: ["group_message"],
      template: ""
    }]
  });
  const record = groupMessage({ rawMessage: "这个按钮\n再往下挪一点", messageId: "msg-2" });
  const messageGroup: PendingMessageGroup = {
    groupId: "message-group-integration",
    key: "napcat|group:10001|sender:42|reply:none",
    baseKey: "napcat|group:10001|sender:42",
    endpoint: "napcat",
    conversationKey: "napcat:group:10001",
    sender: "42",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadlineAt: Date.now(),
    maxDeadlineAt: Date.now(),
    status: "pending",
    attempts: 0,
    items: [{
      identity: "napcat|group:10001|message:msg-2",
      receivedAt: Date.now(),
      incomplete: false,
      payload: { routeKind: "group_message", record, extraValues: {} }
    }]
  };

  try {
    await withForwardingConfig({
      agentAdapters: ["codex"],
      primaryAgentAdapter: "codex",
      messageProcessingAgents: { codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      codexThreadId: "019f0000-0000-7000-8000-000000000001",
      codexThreadName: "主人格",
      codexCwd: root,
      dataDir: path.join(root, "data"),
      memoryDataDir: path.join(root, "memory"),
      routeProfiles: [route]
    }, async () => {
      const result = await forwardMessageAndWait("group_message", record, {}, {
        recordInbound: false,
        messageGroup
      });
      assert.equal(result.status, "delivered");
    });

    assert.deepEqual(requests.map(item => item.action), ["register_group", "read", "resolve", "send", "dispatch"]);
    assert.equal(requests[3]?.model, "gpt-5.6-luna");
    assert.equal(requests[3]?.reasoningEffort, "medium");
    assert.match(String(requests[3]?.prompt), /\[消息组 message-group-integration\]/);
    assert.match(String(requests[3]?.prompt), /你是专职消息处理 Agent/);
  } finally {
    if (oldManagerUrl == null) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = oldManagerUrl;
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    resetMessageProcessingRuntime();
  }
});

test("a grouped reply to an Agent-sent QQ message is routed with the referenced Agent session weight", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const messageGroupDir = path.join(dataDir, "message-groups");
  fs.mkdirSync(messageGroupDir, { recursive: true });
  const familiarThreadId = "019f0000-0000-7000-8000-000000000081";
  const referencedThreadId = "019f0000-0000-7000-8000-000000000082";
  fs.writeFileSync(path.join(messageGroupDir, "agents.json"), JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-11T08:00:00.000Z",
    workers: [
      {
        threadId: familiarThreadId,
        threadName: "Rabi 协助处理消息1",
        workspace: root,
        index: 1,
        createdAt: "2026-08-11T07:00:00.000Z",
        initializedAt: "2026-08-11T07:00:01.000Z",
        affinities: [{
          groupId: "familiar-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:10001",
          sender: "42",
          lastUsedAt: "2026-08-11T07:30:00.000Z"
        }]
      },
      {
        threadId: referencedThreadId,
        threadName: "Rabi 协助处理消息2",
        workspace: root,
        index: 2,
        createdAt: "2026-08-11T07:05:00.000Z",
        initializedAt: "2026-08-11T07:05:01.000Z",
        affinities: [{
          groupId: "other-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:99999",
          sender: "99",
          lastUsedAt: "2026-08-11T07:20:00.000Z"
        }]
      }
    ]
  }), "utf8");
  const sentThreadIds: string[] = [];
  const traceQueries: URL[] = [];
  const manager = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "GET" && requestUrl.pathname === "/api/agent/send/traces") {
      traceQueries.push(requestUrl);
      response.end(JSON.stringify({
        code: 0,
        data: {
          matches: [{
            deliveryId: "delivery-7788",
            result: {
              sender: { agentType: "message_processing", sessionId: referencedThreadId }
            }
          }]
        }
      }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
      if (body.action === "send") sentThreadIds.push(String(body.threadId));
      response.end(JSON.stringify(body.action === "read"
        ? { thread: { status: { type: "idle" } } }
        : body.action === "register_group"
          ? { code: 0, data: { id: body.requirementId, status: "pending_dispatch" } }
          : { code: 0, ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(0, "127.0.0.1", resolve);
  });
  const address = manager.address();
  assert.ok(address && typeof address === "object");
  const oldManagerUrl = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
  resetMessageProcessingRuntime();
  const route = routeProfile(root, {
    notificationRules: [{ id: "group", name: "group", enabled: true, routeKinds: ["group_message"], template: "" }]
  });
  const record = groupMessage({ rawMessage: "[CQ:reply,id=qq-outbound-7788]继续说这个问题", messageId: "msg-reply-agent" });
  const messageGroup: PendingMessageGroup = {
    groupId: "message-group-reply-agent",
    key: "napcat|group:10001|sender:42|reply:qq-outbound-7788",
    baseKey: "napcat|group:10001|sender:42",
    endpoint: "napcat",
    conversationKey: "napcat:group:10001",
    sender: "42",
    replyToMessageId: "qq-outbound-7788",
    createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now(), maxDeadlineAt: Date.now(),
    status: "pending", attempts: 0,
    items: [{
      identity: "napcat|group:10001|message:msg-reply-agent",
      receivedAt: Date.now(), incomplete: false,
      payload: { routeKind: "group_message", record, extraValues: {} }
    }]
  };

  try {
    await withForwardingConfig({
      agentAdapters: ["codex"], primaryAgentAdapter: "codex",
      messageProcessingAgents: { codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      codexThreadId: "019f0000-0000-7000-8000-000000000001", codexThreadName: "主人格", codexCwd: root,
      dataDir, memoryDataDir: path.join(root, "memory"), routeProfiles: [route]
    }, async () => {
      const result = await forwardMessageAndWait("group_message", record, {}, { recordInbound: false, messageGroup });
      assert.equal(result.status, "delivered");
    });

    assert.equal(traceQueries.length, 1);
    assert.equal(traceQueries[0]?.searchParams.get("channel"), "napcat");
    assert.equal(traceQueries[0]?.searchParams.get("sentMessageId"), "qq-outbound-7788");
    assert.equal(traceQueries[0]?.searchParams.get("routeId"), "main");
    assert.deepEqual(sentThreadIds, [referencedThreadId]);
    const routerEvents = fs.readFileSync(path.join(dataDir, "router-adapter.log.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.ok(routerEvents.some((entry) =>
      entry.event === "message_processing_reply_sender_lookup_completed"
      && entry.data?.replyToMessageId === "qq-outbound-7788"
      && entry.data?.referencedSenders?.[0]?.sessionId === referencedThreadId));
    assert.ok(routerEvents.some((entry) =>
      entry.event === "message_processing_reply_sender_weight_applied"
      && entry.data?.selectedThreadId === referencedThreadId
      && entry.data?.selectedReferencedSession === true));
  } finally {
    if (oldManagerUrl == null) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = oldManagerUrl;
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    resetMessageProcessingRuntime();
  }
});

test("heartbeat bypasses the busy-primary skip and goes immediately to a Message Agent when that mode is enabled", async () => {
  const root = tempDir();
  const requests: Array<Record<string, any>> = [];
  const manager = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body.action === "resolve"
        ? { thread: { id: "019f0000-0000-7000-8000-000000000101", title: body.title, cwd: root } }
        : body.action === "read"
          ? { thread: { status: { type: "idle" }, active: false } }
        : { ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(0, "127.0.0.1", resolve);
  });
  const address = manager.address();
  assert.ok(address && typeof address === "object");
  const oldManagerUrl = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
  resetMessageProcessingRuntime();
  const route = routeProfile(root, {
    notificationRules: [{ id: "heartbeat", name: "heartbeat", enabled: true, routeKinds: ["heartbeat"], template: "" }]
  });
  const record: HeartbeatEventRecord = {
    time: 1710000000,
    rawMessage: "巡检当前计划和等待事项。",
    messageId: "heartbeat-1",
    senderName: "RabiRoute",
    intervalSeconds: 900
  };

  try {
    await withForwardingConfig({
      agentAdapters: ["codex"],
      primaryAgentAdapter: "codex",
      messageProcessingAgents: { codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      heartbeatSkipWhenAgentBusy: true,
      codexThreadId: "019f0000-0000-7000-8000-000000000001",
      codexThreadName: "主人格",
      codexCwd: root,
      dataDir: path.join(root, "data"),
      memoryDataDir: path.join(root, "memory"),
      routeProfiles: [route]
    }, async () => {
      const result = await forwardMessageAndWait("heartbeat", record);
      assert.equal(result.status, "delivered");
      assert.equal(result.reason, undefined);
    });

    assert.deepEqual(requests.map(item => item.action), ["read", "resolve", "send"]);
    assert.equal(requests[2]?.model, "gpt-5.6-luna");
    assert.match(String(requests[2]?.prompt), /事件：定时心跳提醒/);
    assert.match(String(requests[2]?.prompt), /\[消息组 message-group-/);
    assert.doesNotMatch(String(requests[2]?.prompt), /消息处理需求 ID：\S/);
    assert.doesNotMatch(String(requests[2]?.prompt), /\[最近消息\]/);
  } finally {
    if (oldManagerUrl == null) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = oldManagerUrl;
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    resetMessageProcessingRuntime();
  }
});

test("replayed platform messages reuse the canonical requirement without a second Agent delivery", async () => {
  const root = tempDir();
  const requests: Array<Record<string, any>> = [];
  const manager = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 0,
        data: { id: "canonical-requirement", status: "processing" }
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(0, "127.0.0.1", resolve);
  });
  const address = manager.address();
  assert.ok(address && typeof address === "object");
  const oldManagerUrl = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
  resetMessageProcessingRuntime();
  const route = routeProfile(root, {
    notificationRules: [{ id: "group", name: "group", enabled: true, routeKinds: ["group_message"], template: "" }]
  });
  const record = groupMessage({ rawMessage: "重复投递", messageId: "same-platform-message" });
  const messageGroup: PendingMessageGroup = {
    groupId: "new-random-group-id",
    key: "napcat|group:10001|sender:42|reply:none",
    baseKey: "napcat|group:10001|sender:42",
    endpoint: "napcat",
    conversationKey: "napcat:group:10001",
    sender: "42",
    createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now(), maxDeadlineAt: Date.now(),
    status: "pending", attempts: 0,
    items: [{
      identity: "napcat|group:10001|message:same-platform-message",
      receivedAt: Date.now(), incomplete: false,
      payload: { routeKind: "group_message", record, extraValues: {} }
    }]
  };

  try {
    await withForwardingConfig({
      agentAdapters: ["codex"], primaryAgentAdapter: "codex",
      messageProcessingAgents: { codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      codexThreadId: "019f0000-0000-7000-8000-000000000001", codexThreadName: "主人格", codexCwd: root,
      dataDir: path.join(root, "data"), memoryDataDir: path.join(root, "memory"), routeProfiles: [route]
    }, async () => {
      const result = await forwardMessageAndWait("group_message", record, {}, { recordInbound: false, messageGroup });
      assert.equal(result.status, "delivered");
    });
    assert.deepEqual(requests.map(item => item.action), ["register_group"]);
  } finally {
    if (oldManagerUrl == null) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = oldManagerUrl;
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    resetMessageProcessingRuntime();
  }
});

test("live chat messages are recorded immediately, batched once, then sent to one Message Agent", async () => {
  const root = tempDir();
  const requests: Array<Record<string, any>> = [];
  let resolveSend!: () => void;
  const sent = new Promise<void>((resolve) => { resolveSend = resolve; });
  const manager = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      if (body.action === "resolve") {
        response.end(JSON.stringify({ thread: { id: "019f0000-0000-7000-8000-000000000100", title: body.title, cwd: root } }));
      } else if (body.action === "read") {
        response.end(JSON.stringify({ thread: { status: { type: "idle" }, active: false } }));
      } else {
        response.end(JSON.stringify({ ok: true }));
        if (body.action === "dispatch") resolveSend();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(0, "127.0.0.1", resolve);
  });
  const address = manager.address();
  assert.ok(address && typeof address === "object");
  const oldManagerUrl = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
  resetMessageProcessingRuntime();
  const route = routeProfile(root, {
    notificationRules: [{ id: "group", name: "group", enabled: true, routeKinds: ["group_message"], template: "" }]
  });

  try {
    await withForwardingConfig({
      agentAdapters: ["codex"],
      primaryAgentAdapter: "codex",
      messageProcessingAgents: { codex: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      messageAdapterPolicies: {
        napcat: { inputEnabled: true, outputEnabled: true, messageGrouping: { enabled: true, settleSeconds: 1, incompleteSettleSeconds: 1, maxWaitSeconds: 1 } }
      },
      codexThreadId: "019f0000-0000-7000-8000-000000000001",
      codexThreadName: "主人格",
      codexCwd: root,
      dataDir: path.join(root, "data"),
      memoryDataDir: path.join(root, "memory"),
      routeProfiles: [route]
    }, async () => {
      forwardMessage("group_message", groupMessage({ rawMessage: "这个按钮", messageId: "fragment-1" }));
      forwardMessage("group_message", groupMessage({ rawMessage: "再往下挪一点", messageId: "fragment-2" }));

      assert.equal(requests.length, 0);
      const rows = fs.readFileSync(path.join(route.rolesDir, route.agentRoleId!, "group-messages.jsonl"), "utf8")
        .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => row.messageId), ["fragment-1", "fragment-2"]);

      await Promise.race([
        sent,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Message Agent delivery timeout")), 4_000))
      ]);
    });

    assert.deepEqual(requests.map(item => item.action), ["register_group", "read", "resolve", "send", "dispatch"]);
    assert.match(String(requests[3]?.prompt), /这个按钮[\s\S]*再往下挪一点/);
    assert.equal(requests[3]?.model, "gpt-5.6-luna");
  } finally {
    if (oldManagerUrl == null) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = oldManagerUrl;
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    resetMessageProcessingRuntime();
  }
});

test("forwardMessageAndWait returns missed when no route profile is active", async () => {
  const root = tempDir();
  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: []
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_active_route_profile");
    assert.equal(result.matchedRuleCount, 0);
    assert.equal(result.sentPacketCount, 0);
    assert.deepEqual(result.routes, []);
  });
});

test("forwardMessageAndWait returns route miss details when no rule matches", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("group_message", groupMessage());

    assert.equal(result.status, "missed");
    assert.equal(result.reason, "no_matching_rule");
    assert.equal(result.routes[0].routeId, "main");
    assert.equal(result.routes[0].status, "missed");
    assert.equal(result.routes[0].reason, "no_matching_rule");
    assert.deepEqual(result.routes[0].matchedRuleIds, []);
    assert.equal(result.sentPacketCount, 0);
  });
});

test("plan feedback uses its system event route without entering chat history", async () => {
  const root = tempDir();
  const roleDataDir = path.join(root, "roles", "Rabi");
  const route = routeProfile(root, {
    notificationRules: []
  });
  const record: PlanFeedbackMessageRecord = {
    time: 1710000000,
    rawMessage: "请按审批意见更新计划。",
    messageId: "plan-feedback-1",
    senderName: "本地用户",
    roleId: "Rabi",
    routeProfileId: route.id,
    adapterType: "planFeedback",
    replyContext: {
      targetType: "plan_feedback",
      planId: "plan-1",
      planFeedbackId: "feedback-1"
    }
  };

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: roleDataDir,
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("plan_feedback", record);

    assert.equal(result.status, "routed");
    assert.deepEqual(result.matchedRuleIds, ["plan-feedback"]);
    assert.equal(fs.existsSync(path.join(roleDataDir, "private-messages.jsonl")), false);
    assert.equal(fs.existsSync(path.join(roleDataDir, "conversation", "current.jsonl")), false);
    const packetLog = fs.readFileSync(path.join(roleDataDir, "agent-packets.jsonl"), "utf8");
    assert.match(packetLog, /路由类型：plan_feedback/);
    assert.doesNotMatch(packetLog, /\[最近消息\]/);
  });
});

test("formal RabiSpeech hot delivery keeps filler transcripts while legacy voice sources stay filtered", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    notificationRules: [{
      id: "voice",
      name: "voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "voice={message}"
    }]
  });
  const speechRecord: VoiceTranscriptEventRecord = {
    time: 1710000000,
    rawMessage: "嗯",
    messageId: "speech-1",
    adapterType: "speech",
    source: "rabispeech",
    transport: "rabipc"
  };
  const legacyRecord: VoiceTranscriptEventRecord = {
    ...speechRecord,
    messageId: "legacy-1",
    adapterType: "fennenote",
    source: "fennenote",
    transport: "webhook"
  };

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "memory"),
    routeProfiles: [route]
  }, async () => {
    const speechResult = await forwardMessageAndWait("voice_transcript", speechRecord);
    const legacyResult = await forwardMessageAndWait("voice_transcript", legacyRecord);

    assert.equal(speechResult.status, "routed");
    assert.equal(speechResult.reason, "no_agent_adapter");
    assert.equal(speechResult.sentPacketCount, 1);
    assert.deepEqual(speechResult.matchedRuleIds, ["voice"]);

    assert.equal(legacyResult.status, "skipped");
    assert.equal(legacyResult.reason, "low_signal_voice_transcript");
    assert.equal(legacyResult.sentPacketCount, 0);
  });
});

test("mobile message endpoint targets one selected route persona instead of broadcasting", async () => {
  const root = tempDir();
  const rule = { id: "mobile", name: "mobile", enabled: true, routeKinds: ["rabilink" as const], template: "{message}" };
  const rabi = routeProfile(root, { id: "Rabi", name: "Rabi", notificationRules: [rule] });
  const ilias = routeProfile(root, { id: "Ilias", name: "Ilias", agentRoleId: "Ilias", notificationRules: [rule] });
  const record: VoiceTranscriptEventRecord = {
    time: 1710000000, rawMessage: "hello Ilias", messageId: "mobile-1",
    adapterType: "rabilink", source: "rabilink-phone-chat", routeProfileId: "Ilias"
  };
  await withForwardingConfig({
    agentAdapters: [], dataDir: path.join(root, "data"), memoryDataDir: path.join(root, "memory"),
    routeProfiles: [rabi, ilias]
  }, async () => {
    const result = await forwardMessageAndWait("rabilink", record);
    assert.deepEqual(result.routes.map((route) => route.routeId), ["Ilias"]);
    assert.equal(result.sentPacketCount, 1);
  });
});

test("mobile PCM speech ingress reaches only its RabiLink persona with a stable reply device", async () => {
  const root = tempDir();
  const ingressStore = new SpeechIngressStore(path.join(root, "host-speech-ingress"));
  const mobileRoleDir = path.join(root, "roles", "Ilias");
  const voiceRoleDir = path.join(root, "roles", "Voice");
  const mobileRule = {
    id: "mobile-audio",
    name: "mobile audio",
    enabled: true,
    routeKinds: ["rabilink" as const],
    template: "{message}"
  };
  const mobileRoute = routeProfile(root, {
    id: "mobile-main",
    name: "Mobile main",
    agentRoleId: "Ilias",
    resolvedPipeline: resolvePipeline("agent"),
    notificationRules: [mobileRule]
  });
  const voiceRoute = routeProfile(root, {
    id: "voice-main",
    name: "Voice main",
    agentRoleId: "Voice",
    notificationRules: [{
      id: "host-voice",
      name: "host voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "{message}"
    }]
  });
  const managerRoutes = [
    { id: "VoiceRuntime", speechEnabled: true, rabiLinkEnabled: false, routeProfileIds: ["voice-main"] },
    { id: "MobileRuntime", speechEnabled: false, rabiLinkEnabled: true, routeProfileIds: ["mobile-main"] }
  ];
  const deliveredRuntimeRoutes: string[] = [];

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "gateway-data"),
    memoryDataDir: path.join(root, "host-history"),
    routeProfiles: [voiceRoute, mobileRoute],
    rolesDir: path.join(root, "roles")
  }, async () => {
    const completedAt = Date.now();
    const control = new ManagerSpeechControl({
      serviceUrl: () => "http://127.0.0.1:8781",
      rolesRoot: () => path.join(root, "roles"),
      route: routeId => managerRoutes.find(route => route.id === routeId),
      routes: () => managerRoutes,
      deliverTranscript: async ({ routeId, record: ingress }) => {
        deliveredRuntimeRoutes.push(routeId);
        const forwarding = createSpeechIngressForwarding(ingress, {
          gatewayId: routeId,
          routeProfileId: ingress.routeProfileId
        });
        const result = await forwardMessageAndWait(forwarding.routeKind, forwarding.record);
        return result.sentPacketCount === 1
          ? { status: "delivered", reason: "test_agent_owner_accepted" }
          : { status: "failed", reason: result.reason || result.status };
      },
      appendRouteLog: () => {},
      speechIngressStore: ingressStore
    });

    const result = await control.acceptMessage({
      recordId: "mobile-audio-one",
      text: "从手机继续处理。",
      sessionId: "phone-session-one",
      messageAdapterType: "rabilink",
      routeProfileId: "mobile-main",
      source: "mobile_audio_stream",
      transport: "rabispeech_remote_audio",
      channelType: "rabilink.mobile_audio",
      sourceDeviceId: "phone-one",
      sourceDeviceName: "测试手机",
      sourceDeviceKind: "mobile",
      sourceStreamId: "phone-one-audio-stream-7",
      sourceHostId: "host-one",
      sourceHostName: "Studio PC",
      provider: "faster-whisper",
      model: "large-v3-turbo",
      language: "zh",
      sampleRate: 16_000,
      audioFormat: "pcm_s16le",
      channels: 1,
      peak: 0.42,
      rms: 0.18,
      startedAt: new Date(completedAt - 2_000).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      ingestedAt: new Date(completedAt + 100).toISOString(),
      duration: 2,
      segments: [{
        id: 0,
        start: 0,
        end: 2,
        text: "从手机继续处理。",
        voiceprintId: "voiceprint-phone-speaker",
        speakerClusterId: "voiceprint-phone-speaker",
        speakerScore: 0.88,
        speakerDecision: "voiceprint_candidate",
        words: [{ word: "手机", start: 0.2, end: 0.5, probability: 0.93 }]
      }]
    });

    assert.equal(result.status, "delivered");
    assert.deepEqual(deliveredRuntimeRoutes, ["MobileRuntime"]);
    assert.equal(ingressStore.list().length, 1);
    assert.equal(fs.existsSync(path.join(voiceRoleDir, "voice-transcripts.jsonl")), false);

    const voiceRows = fs.readFileSync(path.join(mobileRoleDir, "voice-transcripts.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(voiceRows.length, 1);
    assert.equal(voiceRows[0].adapterType, "rabilink");
    assert.equal(voiceRows[0].sourceDeviceId, "phone-one");
    assert.equal(voiceRows[0].sourceStreamId, "phone-one-audio-stream-7");
    assert.equal(voiceRows[0].sourceHostId, "host-one");
    assert.equal(voiceRows[0].provider, "faster-whisper");
    assert.equal(voiceRows[0].rms, 0.18);
    assert.equal((voiceRows[0].segments as Array<Record<string, unknown>>)[0]?.voiceprintId, "voiceprint-phone-speaker");
    assert.equal(((voiceRows[0].segments as Array<Record<string, unknown>>)[0]?.words as Array<Record<string, unknown>>)[0]?.probability, 0.93);

    const conversationRows = fs.readFileSync(path.join(mobileRoleDir, "conversation", "current.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(conversationRows.length, 1);
    assert.equal(conversationRows[0].direction, "inbound");
    assert.equal(conversationRows[0].adapter, "rabilink");
    assert.equal(conversationRows[0].sourceDeviceId, "phone-one");
    assert.equal(conversationRows[0].sourceStreamId, "phone-one-audio-stream-7");
    assert.equal(conversationRows[0].rms, 0.18);

    const packetRows = fs.readFileSync(path.join(mobileRoleDir, "agent-packets.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as { text: string });
    assert.equal(packetRows.length, 1);
    assert.match(packetRows[0].text, /"sourceDeviceId":"phone-one"/);
    assert.match(packetRows[0].text, /"sourceStreamId":"phone-one-audio-stream-7"/);
    assert.match(packetRows[0].text, /"targetDeviceIds":\["phone-one"\]/);
    assert.doesNotMatch(packetRows[0].text, /"targetDeviceIds":\["phone-one-audio-stream-7"\]/);

    const contextMatch = packetRows[0].text.match(/来源上下文（只用于核对来源，不可直接作为发送参数）：(\{[^\r\n]+\})/);
    assert.ok(contextMatch?.[1]);
    const replyContext = JSON.parse(contextMatch[1]) as Record<string, unknown>;
    let relayBody: Record<string, unknown> = {};
    const relay = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        relayBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, status: "queued", messages: [{ id: "mobile-reply-one" }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = relay.address();
      assert.ok(address && typeof address === "object");
      const reply = await handleAgentReply({
        text: "已经从原手机继续处理。",
        replyContext
      }, {
        rootDir: root,
        routeRoot: path.join(root, "data", "route"),
        rolesRoot: path.join(root, "roles"),
        runtimes: [{
          id: "MobileRuntime",
          routeProfiles: [{ id: "mobile-main", agentRoleId: "Ilias" }],
          rabiLinkRelay: {
            enabled: true,
            url: `http://127.0.0.1:${address.port}`,
            token: "test-relay-token",
            deviceId: "host-one"
          },
          messageAdapterPolicies: {
            rabilink: { outputEnabled: true, supportedOutputs: ["text"] }
          }
        }]
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.status, "sent");
      assert.deepEqual(relayBody.targetDeviceIds, ["phone-one"]);
      assert.notDeepEqual(relayBody.targetDeviceIds, ["phone-one-audio-stream-7"]);
      assert.equal(relayBody.taskId, "mobile-audio-one");

      const repliedConversationRows = fs.readFileSync(path.join(mobileRoleDir, "conversation", "current.jsonl"), "utf8")
        .trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(repliedConversationRows.length, 2);
      assert.deepEqual(repliedConversationRows.map(row => row.direction), ["inbound", "outbound"]);
      assert.equal(repliedConversationRows[1].adapter, "rabilink");
    } finally {
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  });
});

test("forwardMessageAndWait reports matched packets separately from adapter delivery", async () => {
  const root = tempDir();
  const routeDataDir = path.join(root, "roles", "Rabi");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir: path.join(root, "data"),
    memoryDataDir: routeDataDir,
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "routed");
    assert.equal(result.reason, "no_agent_adapter");
    assert.deepEqual(result.matchedRuleIds, ["direct"]);
    assert.equal(result.sentPacketCount, 1);
    assert.deepEqual(result.adapterOutcomes, []);

    const packetLog = fs.readFileSync(path.join(routeDataDir, "agent-packets.jsonl"), "utf8");
    assert.match(packetLog, /matched/);
    const situations = fs.readdirSync(path.join(routeDataDir, "conversation", "situations"))
      .filter(file => file.endsWith(".json"));
    assert.equal(situations.length, 1);
    const situation = JSON.parse(fs.readFileSync(path.join(routeDataDir, "conversation", "situations", situations[0]!), "utf8"));
    assert.equal(situation.decisions.mayParticipate, true);
    assert.equal(situation.decisions.mayCreateOrUpdateCurrentProjectRecords, false);
    assert.doesNotMatch(JSON.stringify(situation), /\[CQ:at,qq=12345\] hello/);
    assert.equal(listIdentityEndpointAccounts(routeDataDir).length, 1);
    assert.equal(listIdentityEndpointAccounts(routeDataDir)[0]?.senderStableId, "42");
    assert.equal(listIdentityParticipants(routeDataDir)[0]?.status, "candidate");
    assert.equal(fs.existsSync(path.join(routeDataDir, "codex-notifications.jsonl")), false);
  });
});

test("forwardMessageAndWait surfaces adapter delivery failures", async () => {
  const root = tempDir();
  const route = routeProfile(root, {
    dataDir: path.join(root, "route-data"),
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched"
    }]
  });

  await withForwardingConfig({
    agentAdapters: ["unsupported" as AgentAdapterType],
    dataDir: path.join(root, "data"),
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());

    assert.equal(result.status, "failed");
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.sentPacketCount, 1);
    assert.equal(result.adapterOutcomes.length, 1);
    assert.equal(result.adapterOutcomes[0].adapter, "unsupported");
    assert.equal(result.adapterOutcomes[0].status, "failed");
    assert.match(result.adapterOutcomes[0].error ?? "", /Unsupported agent adapter/);
  });
});

test("forwardMessageAndWait records replayable delivery attempts", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir,
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    const result = await forwardMessageAndWait("direct_at", groupMessage());
    const attempts = readDeliveryReplayAttempts(dataDir);

    assert.equal(result.status, "routed");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].routeKind, "direct_at");
    assert.equal(attempts[0].messageId, "msg-1");
    assert.equal(attempts[0].packets.length, 1);
    assert.match(attempts[0].packets[0].message, /matched/);
  });
});

test("replayDeliveryAttempts can merge failed attempts into one agent packet", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: ["unsupported" as AgentAdapterType],
    dataDir,
    memoryDataDir: path.join(root, "route-data"),
    routeProfiles: [route]
  }, async () => {
    await forwardMessageAndWait("direct_at", groupMessage({ messageId: "msg-1", rawMessage: "[CQ:at,qq=12345] one" }));
    await forwardMessageAndWait("direct_at", groupMessage({ messageId: "msg-2", rawMessage: "[CQ:at,qq=12345] two" }));
    const failedAttempts = readDeliveryReplayAttempts(dataDir).filter((attempt) => attempt.result.status === "failed");

    const replay = await replayDeliveryAttempts(dataDir, {
      mode: "merge",
      attemptIds: failedAttempts.map((attempt) => attempt.attemptId)
    });

    assert.equal(replay.mode, "merge");
    assert.equal(replay.ok, false);
    assert.equal(replay.replayedAttemptIds.length, 2);
    assert.equal(replay.result?.sentPacketCount, 1);
    assert.match(replay.result?.adapterOutcomes[0].error ?? "", /Unsupported agent adapter/);
  });
});

test("replayDeliveryAttempts can backfill a stored message by route kind and message id", async () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const memoryDataDir = path.join(root, "route-data");
  fs.mkdirSync(memoryDataDir, { recursive: true });
  fs.appendFileSync(path.join(memoryDataDir, "private-messages.jsonl"), `${JSON.stringify({
    time: 1710000000,
    userId: 42,
    rawMessage: "old private message",
    messageId: "old-1",
    senderName: "Alice"
  })}\n`, "utf8");
  const route = routeProfile(root, {
    notificationRules: [{
      id: "private",
      name: "private",
      enabled: true,
      routeKinds: ["private"],
      template: "matched {message}"
    }]
  });

  await withForwardingConfig({
    agentAdapters: [],
    dataDir,
    memoryDataDir,
    routeProfiles: [route]
  }, async () => {
    const replay = await replayDeliveryAttempts(dataDir, {
      routeKind: "private",
      messageId: "old-1"
    });

    assert.equal(replay.ok, true);
    assert.equal(replay.result?.status, "routed");
    assert.equal(replay.result?.sentPacketCount, 1);
    const attempts = readDeliveryReplayAttempts(dataDir);
    assert.equal(attempts.at(-1)?.replayOfAttemptId, "stored:private:old-1");
  });
});
