import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RouteProfile } from "../config.js";
import type { GroupMessageRecord, VoiceTranscriptEventRecord } from "../history.js";
import { resolvePipeline } from "../pipelines.js";
import { buildAgentPacket } from "./agentPacket.js";
import { createRouteDecision } from "./routeDecision.js";

function routeProfile(patch: Partial<RouteProfile> = {}): RouteProfile {
  return {
    id: "main",
    name: "Main route",
    enabled: true,
    recentMessageLimit: 10,
    resolvedPipeline: resolvePipeline("qq_chat"),
    agentRoleFile: "persona.md",
    rolesDir: "data/roles",
    routeVariables: {},
    notificationRules: [],
    ...patch
  };
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

function voiceTranscript(patch: Partial<VoiceTranscriptEventRecord> = {}): VoiceTranscriptEventRecord {
  return {
    time: 1710000000,
    rawMessage: "语音输入测试",
    messageId: "voice-1",
    senderName: "fennenote",
    adapterType: "fennenote",
    source: "fennenote",
    ...patch
  };
}

function makeRoleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-packet-role-"));
}

function writeRecentMemory(roleDir: string, memory: Record<string, unknown>): void {
  const filePath = path.join(roleDir, "memory", "recent", `${memory.id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf8");
}

function writeSkill(roleDir: string, fileName: string, text: string): void {
  const filePath = path.join(roleDir, "skills", fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function appendJsonl(filePath: string, items: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

test("RouteDecision records matched rules and normalized route text", () => {
  const route = routeProfile({
    routeVariables: { BotAlias: "12345" },
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      regex: "@{BotAlias} hello",
      template: "matched"
    }]
  });

  const decision = createRouteDecision(route, "direct_at", groupMessage(), {
    selfId: 12345,
    repliedMessage: "[CQ:reply,id=old] previous"
  });

  assert.ok(decision);
  assert.equal(decision.matchedRules[0].id, "direct");
  assert.equal(decision.routeVariables.SenderQQId, "42");
  assert.equal(decision.routeVariables.RobotQQId, "12345");
  assert.equal(decision.routeText, "@12345 hello");
  assert.equal(decision.repliedRouteText, "[Reply:old] previous");
});

test("RouteDecision respects manual trigger rule selection", () => {
  const route = routeProfile({
    notificationRules: [
      { id: "skip", name: "skip", enabled: true, routeKinds: ["manual_trigger"], template: "skip" },
      { id: "run", name: "run", enabled: true, routeKinds: ["manual_trigger"], template: "run" }
    ]
  });

  const decision = createRouteDecision(route, "manual_trigger", groupMessage(), {
    triggerRuleId: "run"
  });

  assert.ok(decision);
  assert.deepEqual(decision.matchedRules.map((rule) => rule.id), ["run"]);
});

test("AgentPacket renders rule template and reply context from a decision", () => {
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "route={routeKind} sender={SenderQQId}"
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage(), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.equal(packet.templateValues.routeKind, "direct_at");
  assert.equal(packet.templateValues.SenderQQId, "42");
  assert.match(packet.message, /route=direct_at sender=42/);

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.routeKind, "direct_at");
  assert.equal(replyContext.outputAdapter, "qq");
  assert.equal(replyContext.replyToSource, true);
});

test("AgentPacket exposes workspace paths as relative paths", () => {
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "role={agentRolePath} data={dataDir}"
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage(), {});
  assert.ok(decision);

  const dataDir = path.join(process.cwd(), "data", "route", "main");
  const roleDir = path.join(process.cwd(), "data", "roles", "Rabi");
  const rolePath = path.join(roleDir, "persona.md");
  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir,
    rolePath,
    dataDir
  });

  assert.equal(packet.templateValues.dataDir, "data/route/main");
  assert.equal(packet.templateValues.agentRoleDir, "data/roles/Rabi");
  assert.equal(packet.templateValues.agentRolePath, "data/roles/Rabi/persona.md");
  assert.equal(packet.templateValues.groupLogPath, "data/route/main/group-messages.jsonl");
  assert.equal(packet.templateValues.agentInterfaceDocPath, "docs/rabi-agent-interfaces.md");
  assert.match(packet.message, /角色文件：data\/roles\/Rabi\/persona\.md/);
  assert.doesNotMatch(packet.message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.dataDir, "data/route/main");
  assert.equal(replyContext.groupLogPath, "data/route/main/group-messages.jsonl");
  assert.equal(replyContext.privateLogPath, "data/route/main/private-messages.jsonl");
});

test("AgentPacket routes FenneNote voice transcript replies through FenneNote output", () => {
  const route = routeProfile({
    resolvedPipeline: resolvePipeline(undefined, {
      outputAdapter: "codex",
      outputPipeline: "codex",
      replyToSource: false
    }),
    notificationRules: [{
      id: "voice",
      name: "voice",
      enabled: true,
      routeKinds: ["voice_transcript"],
      template: "voice={message}"
    }]
  });
  const decision = createRouteDecision(route, "voice_transcript", voiceTranscript(), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir: "data/route/main"
  });

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.routeKind, "voice_transcript");
  assert.equal(replyContext.adapterType, "fennenote");
  assert.equal(replyContext.outputAdapter, "fennenote");
  assert.equal(replyContext.outputPipeline, "fennenote");
  assert.equal(replyContext.replyToSource, false);
  assert.equal(packet.templateValues.promptOutputMode, "voice_short");
  assert.match(packet.message, /回复回传要求/);
  assert.match(packet.message, /不能只在 Codex 线程里写最终文本/);
  assert.match(packet.message, /普通回复 API/);
});

test("AgentPacket injects processing-time context confirmation protocol", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-required",
    title: "任务发布上下文",
    content: "发布任务前需要先确认角色计划和近期记忆。",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["任务发布"]
  });
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: ""
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage({ rawMessage: "[CQ:at,qq=12345] 准备任务发布" }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir,
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.match(packet.message, /\[处理前上下文确认\]/);
  assert.match(packet.message, /回复、发布任务、更新计划、写入记忆或执行外部动作之前/);
  assert.match(packet.message, /GET \/api\/roles\/Rabi\/memory\/recent\/memory-required/);
  assert.match(packet.message, /\[近期记忆\] memory-required：任务发布上下文/);
});

test("AgentPacket injects skill indexes without embedding skill bodies", () => {
  const roleDir = makeRoleDir();
  writeSkill(roleDir, "routing-guide.md", `---
id: routing-guide
title: Routing guide
summary: Explain route kind and policy router concepts.
keywords: route kind, policy router
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Routing guide

SECRET BODY SHOULD NOT BE IN PACKET
`);
  const route = routeProfile({
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: ""
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage({ rawMessage: "[CQ:at,qq=12345] explain route kind" }), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir,
    rolePath: "",
    dataDir: "data/route/main"
  });

  assert.match(packet.message, /可用技能/);
  assert.match(packet.message, /routing-guide：Routing guide - Explain route kind and policy router concepts/);
  assert.match(packet.message, /GET \/api\/roles\/Rabi\/skills\/routing-guide/);
  assert.doesNotMatch(packet.message, /SECRET BODY SHOULD NOT BE IN PACKET/);
});

test("AgentPacket injects route recent messages using the persona limit", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-packet-data-"));
  appendJsonl(path.join(dataDir, "group-messages.jsonl"), [
    { time: 1710000000, groupId: 10001, userId: 1, senderName: "Old", rawMessage: "old message", messageId: "old" },
    { time: 1710000002, groupId: 10001, userId: 2, senderName: "Bob", rawMessage: "second recent", messageId: "second" }
  ]);
  appendJsonl(path.join(dataDir, "private-messages.jsonl"), [
    { time: 1710000001, userId: 3, senderName: "Carol", rawMessage: "first recent", messageId: "first" }
  ]);
  const route = routeProfile({
    recentMessageLimit: 2,
    notificationRules: [{
      id: "direct",
      name: "direct",
      enabled: true,
      routeKinds: ["direct_at"],
      template: "recent={recentMessages}"
    }]
  });
  const decision = createRouteDecision(route, "direct_at", groupMessage(), {});
  assert.ok(decision);

  const packet = buildAgentPacket(decision, decision.matchedRules[0], {
    roleId: "Rabi",
    roleDir: "",
    rolePath: "",
    dataDir
  });

  assert.equal(packet.templateValues.recentMessageLimit, 2);
  assert.match(packet.message, /\[最近消息\]/);
  assert.match(packet.message, /first recent/);
  assert.match(packet.message, /second recent/);
  assert.doesNotMatch(packet.message, /old message/);
});
