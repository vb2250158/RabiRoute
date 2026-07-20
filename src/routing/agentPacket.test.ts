import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { config, type NotificationRule, type RouteProfile } from "../config.js";
import { resolvePipeline } from "../pipelines.js";
import type { GroupMessageRecord } from "../history.js";
import type { RouteDecision } from "./routeDecision.js";
import { buildAgentPacket, type AgentRoleContext } from "./agentPacket.js";

function appendGroupMessage(dataDir: string, record: GroupMessageRecord): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, "group-messages.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

function appendOutboxMessage(dataDir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, "outbox-adapter.log.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

test("AgentPacket expands CQ reply chains and centralizes at mappings", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-"));
  appendGroupMessage(dataDir, {
    time: 1,
    groupId: 9001,
    userId: 10001,
    rawMessage: "历史发言用于提供群名片",
    messageId: 2000,
    senderName: "星海"
  });
  appendGroupMessage(dataDir, {
    time: 2,
    groupId: 9001,
    userId: 10002,
    rawMessage: "最早的问题描述是市集商品卡显示成“商品商品商品/9999”。",
    messageId: 2050,
    senderName: "定位同学"
  });
  appendGroupMessage(dataDir, {
    time: 3,
    groupId: 9001,
    userId: 10003,
    rawMessage: "[CQ:reply,id=2050][CQ:at,qq=10002]已复现，是 1.0.294 后出现的。",
    messageId: 2065,
    senderName: "秋雨Memories"
  });
  appendGroupMessage(dataDir, {
    time: 4,
    groupId: 9001,
    userId: 10004,
    rawMessage: `[CQ:reply,id=2065]${"查到了，根因不是商品配置。".repeat(20)}[CQ:at,qq=10003]`,
    messageId: 2069,
    senderName: "调查同学"
  });

  const record: GroupMessageRecord = {
    time: 5,
    groupId: 9001,
    userId: 10005,
    rawMessage: "[CQ:reply,id=2069][CQ:at,qq=10001] 啥时候出现这个问题的？什么改动导致的？",
    messageId: 2070,
    senderName: "追问同学",
    repliedMessageId: "2069"
  };
  appendGroupMessage(dataDir, record);

  const rule: NotificationRule = {
    id: "rule-1",
    name: "direct reply",
    enabled: true,
    routeKinds: ["direct_reply"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-1",
    name: "main",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const decision: RouteDecision = {
    route,
    routeKind: "direct_reply",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  };
  const roleContext: AgentRoleContext = {
    roleId: "",
    roleDir: "",
    rolePath: "",
    dataDir
  };

  const packet = buildAgentPacket(decision, rule, roleContext);

  assert.match(packet.message, /\[消息代码解析\]/);
  assert.match(packet.message, /\[CQ:reply,id=2069\] : 查到了，根因不是商品配置。/);
  assert.match(packet.message, /……\(更多信息调用接口查看\)/);
  assert.match(packet.message, /  \[CQ:reply,id=2065\] : 已复现，是 1\.0\.294 后出现的。/);
  assert.match(packet.message, /    \[CQ:reply,id=2050\] : 最早的问题描述是市集商品卡显示成/);
  assert.match(packet.message, /\[CQ:at,qq=10001\] : 星海/);
  assert.match(packet.message, /\[CQ:at,qq=10003\] : 秋雨Memories/);
  assert.match(packet.message, /\[CQ:at,qq=10002\] : 定位同学/);
  assert.doesNotMatch(packet.message, /当前消息 messageId/);
  assert.doesNotMatch(packet.message, /纯文本/);
});

test("AgentPacket reads a NapCat get_msg reply cached in the gateway history for a role-bound route", () => {
  const gatewayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-gateway-"));
  const roleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-role-"));
  const previousMemoryDataDir = config.memoryDataDir;
  config.memoryDataDir = gatewayDataDir;
  try {
    appendGroupMessage(gatewayDataDir, {
      time: 1,
      groupId: 9001,
      userId: 10001,
      rawMessage: "通过 OneBot get_msg 补齐的原始问题",
      messageId: 3000,
      senderName: "测试用户",
      lookupSource: "onebot_get_msg"
    });

    const record: GroupMessageRecord = {
      time: 2,
      groupId: 9001,
      userId: 10002,
      rawMessage: "[CQ:reply,id=3000]继续追问",
      messageId: 3001,
      senderName: "追问用户"
    };
    appendGroupMessage(roleDataDir, record);

    const rule: NotificationRule = {
      id: "rule-1",
      name: "direct reply",
      enabled: true,
      routeKinds: ["direct_reply"],
      template: ""
    };
    const route: RouteProfile = {
      id: "route-1",
      name: "main",
      enabled: true,
      recentMessageLimit: 0,
      resolvedPipeline: resolvePipeline("agent"),
      agentRoleFile: "",
      rolesDir: roleDataDir,
      dataDir: gatewayDataDir,
      routeVariables: {},
      notificationRules: [rule]
    };
    const packet = buildAgentPacket({
      route,
      routeKind: "direct_reply",
      record,
      extraValues: {},
      matchedRules: [rule],
      routeVariables: {},
      routeText: record.rawMessage
    }, rule, {
      roleId: "Rabi",
      roleDir: roleDataDir,
      rolePath: "",
      dataDir: roleDataDir
    });

    assert.match(packet.message, /\[CQ:reply,id=3000\] : 通过 OneBot get_msg 补齐的原始问题/);
  } finally {
    config.memoryDataDir = previousMemoryDataDir;
  }
});

test("AgentPacket falls back to sent Outbox messages when QQ history has not cached them", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-outbox-"));
  appendOutboxMessage(dataDir, {
    time: 10,
    adapter: "outbox",
    event: "reply_sent",
    message: "刚发出的测试说明",
    data: {
      ok: true,
      status: "sent",
      targetType: "group",
      groupId: "9001",
      sentMessageId: "3000"
    }
  });

  const record: GroupMessageRecord = {
    time: 11,
    groupId: 9001,
    userId: 10005,
    rawMessage: "[CQ:reply,id=3000]刚刚那条消息",
    messageId: 3001,
    senderName: "追问同学",
    repliedMessageId: "3000"
  };
  const rule: NotificationRule = {
    id: "rule-outbox",
    name: "direct reply",
    enabled: true,
    routeKinds: ["direct_reply"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-outbox",
    name: "main",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const decision: RouteDecision = {
    route,
    routeKind: "direct_reply",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  };
  const packet = buildAgentPacket(decision, rule, {
    roleId: "",
    roleDir: "",
    rolePath: "",
    dataDir
  });

  assert.match(packet.message, /\[CQ:reply,id=3000\] : 刚发出的测试说明/);
  assert.doesNotMatch(packet.message, /暂时无法解析/);
});
