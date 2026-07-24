import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { config, type NotificationRule, type RouteProfile } from "../config.js";
import { updatePersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import { resolvePipeline } from "../pipelines.js";
import type { GroupMessageRecord, VoiceTranscriptEventRecord } from "../history.js";
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
