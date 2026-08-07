import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { config, type NotificationRule, type RouteProfile } from "../config.js";
import { updatePersonaVoiceIdentity } from "../personaVoiceIdentities.js";
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
  assert.match(packet.message, /默认必须让对方看到回应/);
  assert.match(packet.message, /无需新建计划/);
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

  assert.doesNotMatch(packet.message, /人格声纹关系文件/);
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
  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.messageGroupId, "message-group-1");
  assert.deepEqual(replyContext.messageGroupMessageIds, ["3001", "3002"]);
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

    assert.match(packet.message, /\[计划协助会话\]/);
    assert.match(packet.message, /threadId=019fa314-2c07-7523-896f-9bb6b638054b/);
    assert.match(packet.message, /计划管理秘书槽/);
    assert.match(packet.message, /secretaryBinding，记录当前负责秘书/);
    assert.match(packet.message, /不得把秘书 ID 写入 taskBinding/);
    assert.match(packet.message, /taskBinding\.sessionId \+ workspace 必须指向独立业务任务会话/);
    assert.match(packet.message, /秘书及其子 Agent不得直接修改业务文件/);
    assert.match(packet.message, /计划引导\/审批会同时投给业务 taskBinding 和负责秘书/);
    assert.match(packet.message, /业务任务完成提醒、计划进展和状态变化也优先直达负责秘书/);
    assert.match(packet.message, /不再默认唤醒主人格/);
    assert.match(packet.message, /发出秘书消息不等于委派完成/);
    assert.match(packet.message, /核对精确 threadId \+ workspace、秘书真实任务状态和阶段回执/);
    assert.match(packet.message, /秘书开始后等待其结果，不得并行执行同一份日志\/截图读取、查重、计划 PATCH/);
    assert.match(packet.message, /只有当前步骤具有完整、可提交且 responseStatus=pending 的 approvalRequest 时，Manager 才自动派生审批阻塞/);
    assert.match(packet.message, /计划暂停或秘书轮转不能清空业务 taskBinding/);
    assert.match(packet.message, /只有需要用户\/主人格做决定、批准、授权、补充输入/);
    assert.match(packet.message, /计划完整收尾/);
    assert.match(packet.message, /可推进但无人管理的计划数 = 0/);
    assert.match(packet.message, /可推进但空闲的业务任务数 = 0/);
    assert.match(packet.message, /同一 planId 同时只能有一个控制面 writer/);
    assert.match(packet.message, /active cycle 全局阻塞/);
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
  assert.match(packet.message, /事件：计划反馈/);
  assert.match(packet.message, /路由类型：plan_feedback/);
  assert.doesNotMatch(packet.message, /\[最近消息\]/);
  assert.doesNotMatch(packet.message, /\[消息代码解析\]/);
  assert.doesNotMatch(packet.message, /不应注入的历史角色面板消息/);
  assert.equal(packet.templateValues.recentMessageLimit, 0);
  assert.equal(packet.templateValues.recentMessages, "");
  assert.match(packet.message, /面向用户的回复必须回到当前计划记录/);
  assert.match(packet.message, /先按审批意见读取并 PATCH 更新对应计划或步骤/);
  assert.match(packet.message, /isBlocked 由 Manager 根据完整且待决的审批合同自动派生/);
  assert.match(packet.message, /不要重复输出计划回复正文/);

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

  assert.match(guidancePacket.message, /本次是计划引导处理/);
  assert.match(guidancePacket.message, /引导属于整个计划，不绑定某个步骤/);
  assert.match(guidancePacket.message, /同步调整尚未开始的步骤/);
  assert.match(guidancePacket.message, /不带 stepId 的 guidance_response/);
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
  assert.doesNotMatch(packet.message, /把处理说明 POST 到普通回复 API/);
  assert.equal(packet.templateValues.recentMessageLimit, 0);
});

test("AgentPacket exposes processing host and persona-owned voice identity file without naming the speaker", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-packet-voice-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-guid-one",
    voiceprintId: "unknown-cluster-7",
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
  assert.match(packet.message, /unknown-cluster-7：称呼=老板；关系=当前人格的用户；isUser=true/);
  assert.doesNotMatch(packet.message, /host-profile-user|主机资料里的用户/);
  const replyContext = JSON.parse(String(packet.templateValues.replyContextJson));
  assert.equal(replyContext.personaVoiceIdentities[0].identity.displayName, "老板");
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
