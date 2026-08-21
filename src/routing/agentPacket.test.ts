import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { config, type NotificationRule, type RouteProfile } from "../config.js";
import { updatePersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import { listIdentityEndpointAccounts, updateIdentityRelation } from "../identityRelations.js";
import { resolvePipeline } from "../pipelines.js";
import type { GroupMessageRecord, PlanFeedbackMessageRecord, RolePanelMessageRecord, VoiceTranscriptEventRecord } from "../history.js";
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
  assert.match(packet.message, /\[主动协作要求\]/);
  assert.match(packet.message, /明确面向本角色的消息默认回复/);
  assert.match(packet.message, /说明理解、下一步和负责人/);
  assert.doesNotMatch(packet.message, /当前消息 messageId/);
  assert.doesNotMatch(packet.message, /纯文本/);
});

test("AgentPacket keeps an explicit NapCat send target when a QQ route defaults to TTS", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-explicit-send-"));
  const record: GroupMessageRecord = {
    time: 1,
    groupId: 9001,
    userId: 10001,
    rawMessage: "请在群里确认收到。",
    messageId: 2001,
    senderName: "测试用户"
  };
  const rule: NotificationRule = {
    id: "rule-explicit-send",
    name: "group message",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-tts-default",
    name: "tts default",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("voice_chat"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "group_message",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, { roleId: "", roleDir: "", rolePath: "", dataDir });

  const sendRequest = JSON.parse(String(packet.templateValues.sendRequestJson));
  assert.deepEqual(sendRequest.sender, {
    agentType: "<当前 Agent 类型；仅在开启 Codex 主人格发送限制时，主人格填 primary_persona>",
    sessionId: "<当前 Agent 的完整会话 ID>"
  });
  assert.match(packet.message, /仅当当前 Route 在 Codex 的 Hook 管理中开启/);
  assert.equal(sendRequest.routeId, "route-tts-default");
  assert.equal(sendRequest.channel, "napcat");
  assert.deepEqual(sendRequest.params, { target: "group", groupId: 9001, replyToMessageId: "", replyImageDescriptions: [] });
  assert.match(packet.message, /"channel": "napcat"/);
  assert.doesNotMatch(packet.message, /"channel": "speech"/);
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

    assert.equal(packet.messageSource.type, "message_adapter");
    assert.match(packet.message, /^\[消息源\]\n消息源类型：消息端/);
    assert.match(packet.message, /\n\[消息内容\]\n\[CQ:reply,id=3000\]继续追问/);
    assert.match(packet.message, /\[CQ:reply,id=3000\] : 通过 OneBot get_msg 补齐的原始问题/);
    const currentMessageSectionIndex = packet.message.indexOf("[消息内容]");
    const messageCodeSectionIndex = packet.message.indexOf("[消息代码解析]");
    const identitySectionIndex = packet.message.indexOf("[身份定位]");
    assert.ok(messageCodeSectionIndex > currentMessageSectionIndex);
    assert.ok(identitySectionIndex < 0 || messageCodeSectionIndex < identitySectionIndex);
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

test("AgentPacket omits persona voice identity paths from non-audio role panel messages", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-role-panel-"));
  const record: RolePanelMessageRecord = {
    time: Date.now() / 1_000,
    rawMessage: "请整理这份计划。",
    messageId: "role-panel-one",
    senderName: "本地用户",
    roleId: "Rabi",
    adapterType: "rolePanel"
  };
  const rule: NotificationRule = {
    id: "role-panel-rule",
    name: "role panel",
    enabled: true,
    routeKinds: ["role_panel_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "role-panel-route",
    name: "role panel",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "role_panel_message",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.doesNotMatch(packet.message, /语音账号兼容数据文件/);
  assert.doesNotMatch(packet.message, /voice[\\/]voice-identities\.jsonl/);
  assert.equal(packet.templateValues.voiceIdentitiesPath, undefined);
});

test("AgentPacket excludes every fragment already merged into the current message group", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-group-"));
  appendGroupMessage(dataDir, {
    time: 1,
    groupId: 9001,
    userId: 10001,
    rawMessage: "更早但仍然相关的背景",
    messageId: 3000,
    senderName: "小明"
  });
  appendGroupMessage(dataDir, {
    time: 2,
    groupId: 9001,
    userId: 10001,
    rawMessage: "这个按钮",
    messageId: 3001,
    senderName: "小明"
  });
  appendGroupMessage(dataDir, {
    time: 3,
    groupId: 9001,
    userId: 10001,
    rawMessage: "再往下挪一点",
    messageId: 3002,
    senderName: "小明"
  });

  const record = {
    time: 3,
    groupId: 9001,
    userId: 10001,
    rawMessage: "这个按钮\n再往下挪一点",
    messageId: 3002,
    senderName: "小明",
    messageGroupId: "message-group-1",
    messageGroupMessageIds: ["3001", "3002"]
  } satisfies GroupMessageRecord & {
    messageGroupId: string;
    messageGroupMessageIds: string[];
  };
  const rule: NotificationRule = {
    id: "group-message",
    name: "group message",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-1",
    name: "main",
    enabled: true,
    recentMessageLimit: 12,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "group_message",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "",
    roleDir: "",
    rolePath: "",
    dataDir
  });

  assert.match(String(packet.templateValues.recentMessages), /更早但仍然相关的背景/);
  assert.doesNotMatch(String(packet.templateValues.recentMessages), /这个按钮/);
  assert.doesNotMatch(String(packet.templateValues.recentMessages), /再往下挪一点/);
  const recentMessagesSectionIndex = packet.message.indexOf("[最近消息]");
  const currentMessageSectionIndex = packet.message.indexOf("[消息内容]");
  assert.ok(currentMessageSectionIndex >= 0);
  assert.ok(recentMessagesSectionIndex > currentMessageSectionIndex);
  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.messageGroupId, "message-group-1");
  assert.deepEqual(replyContext.messageGroupMessageIds, ["3001", "3002"]);
});

test("AgentPacket highlights the immediate addressed context before interpreting a short group reply", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-addressed-context-"));
  appendGroupMessage(dataDir, {
    time: 90,
    groupId: 798776701,
    userId: 30001,
    rawMessage: "另一个较早的话题",
    messageId: 8000,
    senderName: "其他人"
  });
  appendGroupMessage(dataDir, {
    time: 100,
    groupId: 798776701,
    userId: 2324411326,
    rawMessage: "序号36自己操作测试一下，我无法搞定",
    messageId: 870690296,
    senderName: "QA_刘云云"
  });
  appendGroupMessage(dataDir, {
    time: 106,
    groupId: 798776701,
    userId: 2324411326,
    rawMessage: "[CQ:at,qq=1050739541]",
    messageId: 2115680539,
    senderName: "QA_刘云云"
  });

  const record: GroupMessageRecord = {
    time: 112,
    groupId: 798776701,
    userId: 1050739541,
    rawMessage: "1",
    messageId: 828490779,
    senderName: "秋雨Memories"
  };
  const rule: NotificationRule = {
    id: "addressed-short-reply",
    name: "addressed short reply",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-addressed-short-reply",
    name: "addressed short reply",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "group_message",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, { roleId: "", roleDir: "", rolePath: "", dataDir });

  assert.match(packet.message, /\[紧邻对话\]/);
  assert.match(packet.message, /序号36自己操作测试一下，我无法搞定/);
  assert.match(packet.message, /QA_刘云云：@1050739541/);
  assert.match(packet.message, /当前发言者刚被明确 @/);
  assert.match(packet.message, /先按这段连续对话解释短回复/);
  assert.doesNotMatch(packet.message, /另一个较早的话题/);
});

test("AgentPacket presents broad history before the current message and keeps focused corrections adjacent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-focused-discussion-"));
  appendGroupMessage(dataDir, {
    time: 100,
    groupId: 798776701,
    userId: 10001,
    rawMessage: "[CQ:image,file=dynamic.png] 改动原因是为了更长的底框？为啥？",
    messageId: 1000,
    senderName: "车"
  });
  appendGroupMessage(dataDir, {
    time: 110,
    groupId: 798776701,
    userId: 99999,
    rawMessage: "不是为了单纯把底框做长，而是文字可能超出。",
    messageId: 1001,
    senderName: "星海建造师",
    isSelf: true
  });
  const record: GroupMessageRecord = {
    time: 120,
    groupId: 798776701,
    userId: 10002,
    rawMessage: "动态显示的",
    messageId: 1002,
    senderName: "秋雨Memories"
  };
  const rule: NotificationRule = {
    id: "focused-discussion",
    name: "focused discussion",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "route-focused-discussion",
    name: "focused discussion",
    enabled: true,
    recentMessageLimit: 12,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleFile: "",
    rolesDir: dataDir,
    dataDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "group_message",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, { roleId: "", roleDir: "", rolePath: "", dataDir });

  assert.match(packet.message, /\[当前讨论片段\]/);
  assert.match(packet.message, /改动原因是为了更长的底框/);
  assert.match(packet.message, /不是为了单纯把底框做长/);
  assert.match(packet.message, /“动态显示的”/);
  const recentMessagesSectionIndex = packet.message.indexOf("[最近消息]");
  const currentMessageSectionIndex = packet.message.indexOf("[消息内容]");
  const focusedDiscussionSectionIndex = packet.message.indexOf("[当前讨论片段]");
  assert.ok(currentMessageSectionIndex >= 0);
  assert.ok(recentMessagesSectionIndex > currentMessageSectionIndex);
  assert.ok(focusedDiscussionSectionIndex > recentMessagesSectionIndex);
});

test("AgentPacket exposes exact plan secretary sessions without replacing business task ownership", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-plan-assistant-"));
  const previousSessions = config.codexPlanAssistantSessions;
  config.codexPlanAssistantSessions = [{
    threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
    threadName: "建造师 策划 程序 协助处理计划1",
    workspace: process.cwd(),
    index: 1
  }];
  try {
    const rule: NotificationRule = {
      id: "plan-assistant",
      name: "plan assistant",
      enabled: true,
      routeKinds: ["manual_trigger"],
      template: ""
    };
    const route: RouteProfile = {
      id: "route-plan-assistant",
      name: "plan assistant route",
      enabled: true,
      recentMessageLimit: 0,
      resolvedPipeline: resolvePipeline("agent"),
      agentRoleId: "XinghaiBuilder",
      agentRoleFile: path.join(dataDir, "AGENTS.md"),
      rolesDir: dataDir,
      dataDir,
      routeVariables: {},
      notificationRules: [rule]
    };
    const decision: RouteDecision = {
      route,
      routeKind: "manual_trigger",
      record: {
        time: 1,
        source: "manual",
        rawMessage: "推进计划"
      },
      extraValues: {},
      matchedRules: [rule],
      routeVariables: {},
      routeText: "推进计划"
    };

    const packet = buildAgentPacket(decision, rule, {
      roleId: "XinghaiBuilder",
      roleDir: dataDir,
      rolePath: path.join(dataDir, "AGENTS.md"),
      dataDir
    });

    assert.deepEqual(packet.messageSource, {
      type: "system",
      eventType: "manual_trigger",
      eventName: "手动触发提醒",
      eventId: "1",
      routeName: "plan assistant route",
      routeId: "route-plan-assistant"
    });
    assert.match(packet.message, /^\[消息源\]\n消息源类型：系统/);
    assert.match(packet.message, /\n\[消息内容\]\n推进计划/);
    assert.match(packet.message, /\[计划协助会话\]/);
    assert.match(packet.message, /threadId=019fa314-2c07-7523-896f-9bb6b638054b/);
    assert.match(packet.message, /持久计划秘书/);
    assert.match(packet.message, /secretaryBinding 记录秘书/);
    assert.match(packet.message, /taskBinding\.sessionId \+ workspace 只指向独立业务任务/);
    assert.match(packet.message, /业务任务执行调查、实现、测试、构建、发布和外部操作/);
    assert.match(packet.message, /计划引导、审批和业务结果优先送达负责秘书/);
    assert.match(packet.message, /委派完成以精确 threadId、workspace 和阶段回执为准/);
    assert.match(packet.message, /approvalRequest 完整且 responseStatus=pending 时由 Manager 派生阻塞/);
    assert.match(packet.message, /秘书轮转或计划暂停不清空 taskBinding/);
    assert.match(packet.message, /仅把决定、批准、授权、缺少输入或最终复核升级给主人格/);
    assert.match(packet.message, /没有无人管理或可推进但空闲的计划/);
    assert.match(packet.message, /同一 planId 只有一个控制面 writer/);
  } finally {
    config.codexPlanAssistantSessions = previousSessions;
  }
});

test("AgentPacket tells the Agent to inquire on every inspection while a plan is waiting", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-plan-inquiry-"));
  const planId = "plan-waiting-owner-answer";
  const planDir = path.join(roleDir, "plans", "items", "active");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, `${planId}.json`), JSON.stringify({
    id: planId,
    title: "等待负责人答复",
    focus: "取得明确业务口径",
    status: "进行中",
    currentStepId: "ask-owner",
    waitingFor: "负责人回复",
    isBlocked: true,
    blockedBy: "负责人尚未确认",
    steps: [{
      id: "ask-owner",
      title: "询问负责人并取得明确结果",
      status: "进行中",
      waitingFor: "负责人回复",
      isBlocked: true,
      blockedBy: "负责人尚未确认"
    }],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    keywords: ["负责人", "确认"]
  }), "utf8");

  const rule: NotificationRule = {
    id: "plan-inquiry",
    name: "plan inquiry",
    enabled: true,
    routeKinds: ["manual_trigger"],
    template: `巡检 ${planId}`
  };
  const route: RouteProfile = {
    id: "route-plan-inquiry",
    name: "plan inquiry route",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "XinghaiBuilder",
    agentRoleFile: path.join(roleDir, "persona.md"),
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "manual_trigger",
    record: { time: 1, source: "manual", rawMessage: `巡检 ${planId}` },
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: `巡检 ${planId}`
  }, rule, {
    roleId: "XinghaiBuilder",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.match(packet.message, /等待对象：负责人回复/);
  assert.match(packet.message, /巡检动作：主动询问、重试、改道或补证据，直到取得明确结果/);
  assert.match(packet.message, /待确认说明：负责人尚未确认/);
  assert.doesNotMatch(packet.message, /阻塞原因：负责人尚未确认/);
});

test("AgentPacket keeps incomplete approval preparation actionable instead of blocked", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-plan-approval-preparing-"));
  const planId = "plan-approval-preparing";
  const planDir = path.join(roleDir, "plans", "items", "active");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, `${planId}.json`), JSON.stringify({
    id: planId,
    title: "准备审批合同",
    focus: "补齐真实执行边界后再请求审批",
    status: "进行中",
    currentStepId: "approve",
    isBlocked: true,
    blockedBy: "缺少正式资源与执行范围",
    steps: [{
      id: "approve",
      title: "准备审批合同",
      status: "进行中",
      isBlocked: true,
      blockedBy: "缺少正式资源与执行范围",
      approvalRequest: {
        request: "批准后续实现。",
        reason: "需要确认范围。",
        files: [],
        commands: [],
        changes: [],
        validation: [],
        rollback: [],
        outOfScope: []
      }
    }],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    keywords: ["审批", "合同"]
  }), "utf8");

  const rule: NotificationRule = {
    id: "plan-approval-preparing",
    name: "plan approval preparing",
    enabled: true,
    routeKinds: ["manual_trigger"],
    template: `巡检 ${planId}`
  };
  const route: RouteProfile = {
    id: "route-plan-approval-preparing",
    name: "plan approval preparing route",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "XinghaiBuilder",
    agentRoleFile: path.join(roleDir, "persona.md"),
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "manual_trigger",
    record: { time: 1, source: "manual", rawMessage: `巡检 ${planId}` },
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: `巡检 ${planId}`
  }, rule, {
    roleId: "XinghaiBuilder",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.match(packet.message, /审批合同尚未完整，计划保持进行中/);
  assert.match(packet.message, /不能把资料缺失标成阻塞/);
  assert.match(packet.message, /待确认说明：缺少正式资源与执行范围/);
  assert.doesNotMatch(packet.message, /阻塞原因：缺少正式资源与执行范围/);
});

test("AgentPacket routes plan approval responses back to the plan instead of leaving them in Codex", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-plan-feedback-"));
  fs.mkdirSync(path.join(roleDir, "conversation"), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "conversation", "current.jsonl"), `${JSON.stringify({
    time: 1,
    direction: "inbound",
    adapter: "rolePanel",
    conversationKey: "role:Rabi",
    text: "不应注入的历史角色面板消息"
  })}\n`, "utf8");
  const record: PlanFeedbackMessageRecord = {
    time: Date.now() / 1_000,
    rawMessage: "请把原问题和修改范围写清楚。",
    messageId: "plan-feedback-request-1",
    senderName: "本地用户",
    roleId: "Rabi",
    adapterType: "planFeedback",
    replyContext: {
      targetType: "plan_feedback",
      planId: "plan-1",
      planTitle: "消息源统一计划",
      planStepId: "approval",
      planFeedbackId: "feedback-1",
      planFeedbackResponseId: "response-feedback-1",
      planFeedbackKind: "approval_suggestion"
    }
  };
  const rule: NotificationRule = {
    id: "plan-feedback",
    name: "plan feedback",
    enabled: true,
    routeKinds: ["plan_feedback"],
    template: ""
  };
  const route: RouteProfile = {
    id: "role-panel-route",
    name: "role panel",
    enabled: true,
    recentMessageLimit: 12,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "plan_feedback",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(packet.templateValues.targetType, "plan_feedback");
  assert.equal(replyContext.planId, "plan-1");
  assert.equal(replyContext.planFeedbackResponseId, "response-feedback-1");
  assert.deepEqual(packet.messageSource, {
    type: "plan",
    planName: "消息源统一计划",
    planId: "plan-1"
  });
  assert.match(packet.message, /^\[消息源\]\n消息源类型：计划\n计划名称：消息源统一计划\n计划 ID：plan-1/);
  assert.match(packet.message, /事件：计划反馈/);
  assert.match(packet.message, /路由类型：plan_feedback/);
  assert.doesNotMatch(packet.message, /\[最近消息\]/);
  assert.doesNotMatch(packet.message, /\[消息代码解析\]/);
  assert.doesNotMatch(packet.message, /不应注入的历史角色面板消息/);
  assert.equal(packet.templateValues.recentMessageLimit, 0);
  assert.equal(packet.templateValues.recentMessages, "");
  assert.match(packet.message, /处理说明通过明确发送 API 写入当前 planId \/ stepId/);
  assert.match(packet.message, /读取审批记录并 PATCH 计划或步骤/);
  assert.match(packet.message, /isBlocked 由 Manager 派生/);
  assert.match(packet.message, /简短说明计划已更新、回复已回写/);

  const guidancePacket = buildAgentPacket({
    route,
    routeKind: "plan_feedback",
    record: {
      ...record,
      rawMessage: "先收窄整体范围，再调整后续未开始步骤。",
      messageId: "plan-feedback-guidance-1",
      replyContext: {
        targetType: "plan_feedback",
        planId: "plan-1",
        planTitle: "消息源统一计划",
        planFeedbackId: "guidance-1",
        planFeedbackResponseId: "response-guidance-1",
        planFeedbackKind: "guidance"
      }
    },
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: "先收窄整体范围，再调整后续未开始步骤。"
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.match(guidancePacket.message, /读取计划与反馈，按引导推进/);
  assert.match(guidancePacket.message, /范围、优先级或路径变化时 PATCH 计划/);
  assert.match(guidancePacket.message, /PATCH 计划和未开始步骤/);
  assert.match(guidancePacket.message, /当前 planId 的 guidance_response/);
  assert.doesNotMatch(guidancePacket.message, /approvalRequest\.responseStatus/);
});

test("AgentPacket treats an auto-delivered approval as a persona notice without asking for duplicate handling", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-plan-feedback-notice-"));
  const record: PlanFeedbackMessageRecord = {
    time: Date.now() / 1_000,
    rawMessage: "审批已自动投递到绑定业务会话，无需再次转发。",
    messageId: "plan-feedback-notice-1",
    senderName: "RabiRoute Manager",
    roleId: "Rabi",
    adapterType: "planFeedback",
    replyContext: {
      targetType: "plan_feedback_notice",
      planId: "plan-1",
      planTitle: "消息源统一计划",
      planStepId: "approval",
      planFeedbackId: "feedback-1",
      planFeedbackAutoDelivered: true
    }
  };
  const rule: NotificationRule = {
    id: "plan-feedback",
    name: "plan feedback",
    enabled: true,
    routeKinds: ["plan_feedback"],
    template: ""
  };
  const route: RouteProfile = {
    id: "role-panel-route",
    name: "role panel",
    enabled: true,
    recentMessageLimit: 12,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "plan_feedback",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.equal(packet.templateValues.targetType, "plan_feedback_notice");
  assert.match(packet.message, /已自动投递到绑定业务会话/);
  assert.match(packet.message, /无需再次转发/);
  assert.doesNotMatch(packet.message, /先按审批意见读取并 PATCH 更新对应计划或步骤/);
  assert.doesNotMatch(packet.message, /把处理说明 POST 到明确发送 API/);
  assert.equal(packet.templateValues.recentMessageLimit, 0);
});

test("AgentPacket exposes processing host and persona-owned voice identity file without naming the speaker", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-voice-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-guid-one",
    voiceprintId: "unknown-cluster-7",
    participantId: "participant-owner",
    displayName: "老板",
    relationship: "当前人格的用户",
    isUser: true,
    aliases: ["老板"]
  });
  const record: VoiceTranscriptEventRecord = {
    time: Date.now() / 1_000,
    rawMessage: "今天继续做同步。",
    messageId: "speech-one",
    adapterType: "speech",
    source: "rabispeech",
    sourceHostId: "host-guid-one",
    sourceHostName: "Studio PC",
    voiceprintId: "unknown-cluster-7",
    speakerId: "host-profile-user",
    speakerName: "主机资料里的用户",
    speakerDecision: "voiceprint_unknown_cluster",
    sessionId: "speech-day-one"
  };
  const rule: NotificationRule = {
    id: "voice-rule",
    name: "voice",
    enabled: true,
    routeKinds: ["voice_transcript"],
    template: ""
  };
  const route: RouteProfile = {
    id: "voice-route",
    name: "voice",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "voice_transcript",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.match(packet.message, /语音处理主机：Studio PC/);
  assert.match(packet.message, /声纹 ID：unknown-cluster-7/);
  assert.match(packet.message, /voice[\\/]voice-identities\.jsonl/);
  assert.match(packet.message, /不判断这个人是谁，也不判断谁是用户/);
  assert.match(packet.message, /unknown-cluster-7：身份=participant-owner；称呼=老板；关系=当前人格的用户；isUser=true/);
  assert.doesNotMatch(packet.message, /host-profile-user|主机资料里的用户/);
  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.personaVoiceIdentities[0].identity.displayName, "老板");
  assert.equal(replyContext.personaVoiceIdentities[0].identity.participantId, "participant-owner");
  assert.equal(replyContext.speakerId, undefined);
  assert.equal(replyContext.speakerName, undefined);
  assert.equal(replyContext.voiceprintId, "unknown-cluster-7");
});

test("RabiLink audio keeps the stable reply device separate from the transient PCM stream", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-mobile-audio-"));
  const record: VoiceTranscriptEventRecord = {
    time: Date.now() / 1_000,
    rawMessage: "手机语音。",
    messageId: "mobile-speech-one",
    adapterType: "rabilink",
    source: "mobile_audio_stream",
    channelType: "rabilink.mobile_audio",
    messageAdapterType: "rabilink",
    sourceDeviceId: "phone-one",
    sourceDeviceKind: "mobile",
    sourceStreamId: "phone-one-phone-audio",
    sessionId: "phone-one"
  };
  const rule: NotificationRule = {
    id: "mobile-voice-rule",
    name: "mobile voice",
    enabled: true,
    routeKinds: ["rabilink"],
    template: ""
  };
  const route: RouteProfile = {
    id: "mobile-route",
    name: "mobile",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "rabilink",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.targetType, "rabilink");
  assert.equal(replyContext.adapterType, "rabilink");
  assert.equal(replyContext.sourceDeviceId, "phone-one");
  assert.equal(replyContext.sourceStreamId, "phone-one-phone-audio");
  assert.deepEqual(replyContext.targetDeviceIds, ["phone-one"]);
  assert.equal(packet.templateValues.voiceSourceStreamId, "phone-one-phone-audio");
});

test("AgentPacket injects persona-owned identity state for every voiceprint in a multi-speaker turn", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-multi-voice-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "meeting-host",
    voiceprintId: "cluster-known",
    displayName: "同事甲",
    relationship: "项目同事",
    isUser: false,
    aliases: []
  });
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "meeting-host",
    voiceprintId: "host-profile-known",
    displayName: "主机候选资料",
    relationship: "诊断信息",
    isUser: true,
    aliases: []
  });
  const record: VoiceTranscriptEventRecord = {
    time: Date.now() / 1_000,
    rawMessage: "cluster-known：先做接口。\ncluster-guest：我来测试。",
    messageId: "speech-multi",
    adapterType: "speech",
    source: "rabispeech",
    sourceHostId: "meeting-host",
    sourceHostName: "Meeting PC",
    sessionId: "meeting-one",
    segments: [
      {
        id: 0,
        start: 0,
        end: 1,
        text: "先做接口。",
        voiceprintId: "cluster-known",
        speakerClusterId: "cluster-known",
        speakerId: "host-profile-known",
        speakerSuggestionId: "host-profile-known"
      },
      { id: 1, start: 1, end: 2, text: "我来测试。", speakerClusterId: "cluster-guest" }
    ]
  };
  const rule: NotificationRule = { id: "multi-voice", name: "multi voice", enabled: true, routeKinds: ["voice_transcript"], template: "" };
  const route: RouteProfile = {
    id: "multi-voice-route",
    name: "multi voice",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packet = buildAgentPacket({
    route,
    routeKind: "voice_transcript",
    record,
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, { roleId: "Rabi", roleDir, rolePath: path.join(roleDir, "persona.md"), dataDir: roleDir });

  assert.match(packet.message, /本段声纹：cluster-known, cluster-guest/);
  assert.match(packet.message, /cluster-known：称呼=同事甲；关系=项目同事；isUser=false/);
  assert.match(packet.message, /cluster-guest：当前人格尚未确认/);
  assert.doesNotMatch(packet.message, /host-profile-known/);
  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.deepEqual(replyContext.personaVoiceIdentities.map((item: { voiceprintId: string }) => item.voiceprintId), ["cluster-known", "cluster-guest"]);
  assert.equal(replyContext.speakerId, undefined);
});

test("AgentPacket exposes one-shot persona capabilities only for explicit current intent", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-persona-sync-"));
  const rule: NotificationRule = {
    id: "persona-sync-intent",
    name: "persona sync intent",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "persona-sync-route",
    name: "persona sync",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Rabi",
    agentRoleFile: "persona.md",
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const packetFor = (rawMessage: string) => buildAgentPacket({
    route,
    routeKind: "group_message",
    record: {
      time: Date.now() / 1_000,
      groupId: 100,
      userId: 200,
      messageId: rawMessage,
      rawMessage
    },
    extraValues: {},
    matchedRules: [rule],
    routeVariables: {},
    routeText: rawMessage
  }, rule, {
    roleId: "Rabi",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  const syncPacket = packetFor("我有多台电脑，请把当前人格同步到另一台电脑。");
  assert.match(syncPacket.message, /\[多电脑人格同步\]/);
  assert.match(syncPacket.message, /GET http:\/\/127\.0\.0\.1:8790\/api\/persona-sync\/peers/);
  assert.match(syncPacket.message, /POST http:\/\/127\.0\.0\.1:8790\/api\/persona-sync\/sync/);
  assert.match(syncPacket.message, /"roleId": "Rabi"/);
  assert.match(syncPacket.message, /只执行一次查询\/同步，不创建后台轮询/);
  assert.match(syncPacket.message, /存在冲突时不能声称同步完成/);

  const ordinaryPacket = packetFor("请整理一下今天的会议记录。");
  assert.doesNotMatch(ordinaryPacket.message, /\[多电脑人格同步\]/);
  assert.doesNotMatch(ordinaryPacket.message, /api\/persona-sync\/peers/);

  const voiceReviewPacket = packetFor("今天的录音里哪些是我说的，哪些是别人说的？");
  assert.match(voiceReviewPacket.message, /\[全天语音与声纹归类\]/);
  assert.match(voiceReviewPacket.message, /voice-transcripts\?from=<ISO>&to=<ISO>&speaker=<user\|other\|unknown\|conflict>/);
  assert.match(voiceReviewPacket.message, /PUT http:\/\/127\.0\.0\.1:8790\/api\/roles\/Rabi\/voice-identities/);
  assert.match(voiceReviewPacket.message, /证据不足时保持 unknown/);
  assert.doesNotMatch(ordinaryPacket.message, /\[全天语音与声纹归类\]/);
});

test("AgentPacket injects identity context without turning another project's discussion into current-project ownership", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-identity-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON",
    status: "confirmed", aliases: [], evidenceRefs: [{ messageId: "identity-confirmed" }]
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "200",
    participantLinks: [{ participantId: "participant-cotton", status: "confirmed", confidence: 1, evidenceRefs: [{ messageId: "identity-confirmed" }] }]
  });
  updateIdentityRelation(roleDir, {
    kind: "relation_card", relationId: "relation-edge-space", subjectParticipantId: "participant-cotton",
    targetKind: "project", targetId: "edge-space", relationship: "参与讨论", status: "confirmed",
    scope: { conversationKeys: ["napcat:instance:qq-main:group:100"], projectIds: [] }, evidenceRefs: [{ messageId: "message-other-project" }]
  });
  const rule: NotificationRule = { id: "identity", name: "identity", enabled: true, routeKinds: ["group_message"], template: "" };
  const route: RouteProfile = {
    id: "identity-route", name: "identity", enabled: true, recentMessageLimit: 0, resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Xinghai", agentRoleFile: "persona.md", rolesDir: path.dirname(roleDir), dataDir: roleDir, routeVariables: {}, notificationRules: [rule]
  };
  const record: GroupMessageRecord = {
    time: Date.now() / 1_000, groupId: 100, userId: 200, messageId: "message-other-project", senderName: "COTTON",
    instanceId: "qq-main", rawMessage: "边缘空间的原型可以先这样试。"
  };
  const packet = buildAgentPacket({ route, routeKind: "group_message", record, extraValues: {}, matchedRules: [rule], routeVariables: {}, routeText: record.rawMessage }, rule, {
    roleId: "Xinghai", roleDir, rolePath: path.join(roleDir, "persona.md"), dataDir: roleDir
  });
  assert.match(packet.message, /\[身份定位\]/);
  assert.match(packet.message, /已确认参与者：COTTON/);
  assert.match(packet.message, /不能单独证明项目归属、委托、决策权或执行授权/);
  assert.match(packet.message, /identity-relations API/);
  assert.match(packet.message, /\[情景记录\]/);
  assert.match(packet.message, /已确认项目关系：edge-space（参与讨论）/);
  assert.match(packet.message, /可以自然参与有价值的讨论、澄清问题或提出建议/);
  assert.match(packet.message, /不得据此查询、创建、更新或转交任何项目计划、任务或长期项目记忆/);
});

test("AgentPacket preview does not create identity records", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-identity-preview-"));
  const rule: NotificationRule = { id: "identity-preview", name: "identity-preview", enabled: true, routeKinds: ["group_message"], template: "" };
  const route: RouteProfile = {
    id: "identity-preview-route", name: "identity preview", enabled: true, recentMessageLimit: 0, resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "Xinghai", agentRoleFile: "persona.md", rolesDir: path.dirname(roleDir), dataDir: roleDir, routeVariables: {}, notificationRules: [rule]
  };
  const record: GroupMessageRecord = {
    time: Date.now() / 1_000, groupId: 100, userId: 999, messageId: "preview-message", senderName: "陌生人",
    botUserId: "888", rawMessage: "预览不应写入身份。"
  };
  buildAgentPacket({ route, routeKind: "group_message", record, extraValues: {}, matchedRules: [rule], routeVariables: {}, routeText: record.rawMessage }, rule, {
    roleId: "Xinghai", roleDir, rolePath: path.join(roleDir, "persona.md"), dataDir: roleDir
  });
  assert.equal(listIdentityEndpointAccounts(roleDir).length, 0);
});

test("AgentPacket requires a bound latest-context review before a message-processing reply", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-send-context-"));
  const rule: NotificationRule = {
    id: "message-processing-send-context",
    name: "message processing send context",
    enabled: true,
    routeKinds: ["group_message"],
    template: ""
  };
  const route: RouteProfile = {
    id: "message-processing-route",
    name: "message processing route",
    enabled: true,
    recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"),
    agentRoleId: "XinghaiBuilder",
    agentRoleFile: path.join(roleDir, "persona.md"),
    rolesDir: path.dirname(roleDir),
    dataDir: roleDir,
    routeVariables: {},
    notificationRules: [rule]
  };
  const record: GroupMessageRecord = {
    time: Date.now() / 1_000,
    groupId: 100,
    userId: 200,
    messageId: "source-message-1",
    senderName: "测试用户",
    rawMessage: "请确认这条群消息。"
  };

  const packet = buildAgentPacket({
    route,
    routeKind: "group_message",
    record,
    extraValues: { messageProcessingRequirementId: "requirement-1" },
    matchedRules: [rule],
    routeVariables: {},
    routeText: record.rawMessage
  }, rule, {
    roleId: "XinghaiBuilder",
    roleDir,
    rolePath: path.join(roleDir, "persona.md"),
    dataDir: roleDir
  });

  assert.match(packet.message, /requirements\/requirement-1\/send-context/);
  assert.match(packet.message, /核对最新消息，取得 sendContextReviewToken/);
  assert.match(packet.message, /sendContextReviewToken/);
  assert.match(packet.message, /发送目标或正文变化时重新审核/);
  assert.match(packet.message, /replyImageDescriptions/);
  assert.match(packet.message, /逐张填写 params\.replyImageDescriptions/);
});
