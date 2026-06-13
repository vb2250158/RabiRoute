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
