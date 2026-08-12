import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FeishuMessageRecord, GroupMessageRecord, VoiceTranscriptEventRecord, WeComMessageRecord, WeixinMessageRecord } from "../history.js";
import { updateIdentityRelation } from "../identityRelations.js";
import { identityContextForForward, identityContextLines, identityEndpointForForward, identityEndpointsForForward } from "./identityContext.js";

test("forward identity lookup ignores Route configuration and uses the actual message endpoint identity", () => {
  const record: GroupMessageRecord = {
    time: 1, groupId: 100, userId: 200, rawMessage: "我在讨论另一个项目", messageId: "m-1", senderName: "COTTON", instanceId: "qq-main"
  };
  const first = identityEndpointForForward("group_message", record, { gatewayId: "route-one", routeProfileId: "profile-one" });
  const second = identityEndpointForForward("group_message", record, { gatewayId: "route-two", routeProfileId: "profile-two" });
  assert.deepEqual(first && { ...first, conversationKey: undefined }, second && { ...second, conversationKey: undefined });
  assert.deepEqual(first && {
    platform: first.platform,
    endpointIdentityNamespace: first.endpointIdentityNamespace,
    senderStableId: first.senderStableId
  }, { platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "200" });
});

test("NapCat prefers its stable bot account over a renameable instance name for the endpoint namespace", () => {
  const beforeRename: GroupMessageRecord = {
    time: 1, groupId: 100, userId: 200, rawMessage: "消息", messageId: "m-1", instanceId: "qq-main", botUserId: "999"
  };
  const afterRename: GroupMessageRecord = { ...beforeRename, messageId: "m-2", instanceId: "qq-main-renamed" };
  assert.equal(identityEndpointForForward("group_message", beforeRename)?.endpointIdentityNamespace, "bot:999");
  assert.equal(identityEndpointForForward("group_message", afterRename)?.endpointIdentityNamespace, "bot:999");
});

test("web message endpoints require their configured stable namespace instead of sharing a default", () => {
  const wecom: WeComMessageRecord = {
    time: 1, rawMessage: "消息", adapterType: "wecom", userId: "member", senderId: "member",
    identityNamespace: "bot:wecom-app"
  };
  const feishu: FeishuMessageRecord = {
    time: 1, rawMessage: "消息", messageId: "message", eventId: "event", adapterType: "feishu",
    chatId: "chat", groupId: "chat", userId: "member", messageType: "text", identityNamespace: "app:feishu-app"
  };
  const weixin: WeixinMessageRecord = {
    time: 1, rawMessage: "消息", messageId: "message", adapterType: "weixin", sessionId: "member",
    userId: "member", messageType: "text", identityNamespace: "bot:weixin-app"
  };
  assert.equal(identityEndpointForForward("wecom_message", wecom)?.endpointIdentityNamespace, "bot:wecom-app");
  assert.equal(identityEndpointForForward("feishu_message", feishu)?.endpointIdentityNamespace, "app:feishu-app");
  assert.equal(identityEndpointForForward("weixin_message", weixin)?.endpointIdentityNamespace, "bot:weixin-app");
  assert.equal(identityEndpointForForward("wecom_message", { ...wecom, identityNamespace: undefined }), undefined);
});

test("voice message endpoints use processing host plus each opaque voiceprint as separate stable accounts", () => {
  const record: VoiceTranscriptEventRecord = {
    time: 1,
    rawMessage: "甲说一句。乙说一句。",
    messageId: "voice-message",
    adapterType: "speech",
    voiceIdentityTrusted: true,
    sourceHostId: "workstation-a",
    sourceHostName: "工作站 A",
    segments: [
      { id: 1, start: 0, end: 1, text: "甲说一句", voiceprintId: "cluster-a", speakerName: "说话人 A" },
      { id: 2, start: 1, end: 2, text: "乙说一句", speakerClusterId: "cluster-b", speakerName: "说话人 B" }
    ]
  };
  assert.deepEqual(identityEndpointsForForward("voice_transcript", record).map(item => ({
    platform: item.platform,
    endpointIdentityNamespace: item.endpointIdentityNamespace,
    senderStableId: item.senderStableId,
    displayName: item.displayName
  })), [
    { platform: "voice", endpointIdentityNamespace: "host:workstation-a", senderStableId: "cluster-a", displayName: "说话人 A" },
    { platform: "voice", endpointIdentityNamespace: "host:workstation-a", senderStableId: "cluster-b", displayName: "说话人 B" }
  ]);
});

test("generic and RabiLink message endpoints can provide the same explicit stable identity fields", () => {
  const record: VoiceTranscriptEventRecord = {
    time: 1,
    rawMessage: "来自移动端的文字消息",
    messageId: "mobile-message",
    adapterType: "rabilink",
    senderIdentityTrusted: true,
    identityNamespace: "relay:device-owner",
    senderStableId: "user-42",
    senderName: "移动端用户"
  };
  const endpoint = identityEndpointForForward("rabilink", record);
  assert.ok(endpoint);
  assert.deepEqual({
    platform: endpoint.platform,
    endpointIdentityNamespace: endpoint.endpointIdentityNamespace,
    senderStableId: endpoint.senderStableId,
    displayName: endpoint.displayName
  }, {
    platform: "rabilink",
    endpointIdentityNamespace: "relay:device-owner",
    senderStableId: "user-42",
    displayName: "移动端用户"
  });
});

test("a trusted RabiLink audio message retains both its device account and every voice account", () => {
  const record: VoiceTranscriptEventRecord = {
    time: 1,
    rawMessage: "移动端语音",
    messageId: "mobile-audio",
    adapterType: "rabilink",
    senderIdentityTrusted: true,
    voiceIdentityTrusted: true,
    identityNamespace: "relay:rabilink",
    senderStableId: "phone-one",
    senderName: "Phone",
    sourceHostId: "speech-host",
    voiceprintId: "voice-one"
  };

  assert.deepEqual(identityEndpointsForForward("rabilink", record).map(item => ({
    platform: item.platform,
    endpointIdentityNamespace: item.endpointIdentityNamespace,
    senderStableId: item.senderStableId
  })), [
    { platform: "voice", endpointIdentityNamespace: "host:speech-host", senderStableId: "voice-one" },
    { platform: "rabilink", endpointIdentityNamespace: "relay:rabilink", senderStableId: "phone-one" }
  ]);
});

test("an authenticated Relay sender cannot make client-supplied voiceprint fields authoritative", () => {
  const record: VoiceTranscriptEventRecord = {
    time: 1,
    rawMessage: "客户端声称的声纹",
    messageId: "relay-spoofed-voice",
    adapterType: "rabilink",
    senderIdentityTrusted: true,
    identityNamespace: "relay:rabilink",
    senderStableId: "phone-one",
    sourceHostId: "trusted-speech-host",
    voiceprintId: "known-voiceprint"
  };

  assert.deepEqual(identityEndpointsForForward("rabilink", record).map(item => item.platform), ["rabilink"]);
});

test("untrusted webhook payload fields cannot impersonate an existing identity endpoint", () => {
  const record: VoiceTranscriptEventRecord = {
    time: 1,
    rawMessage: "伪造的身份字段",
    messageId: "untrusted-webhook",
    adapterType: "webhook",
    identityNamespace: "bot:trusted",
    senderStableId: "known-user",
    sourceHostId: "trusted-host",
    voiceprintId: "known-voiceprint"
  };
  assert.deepEqual(identityEndpointsForForward("voice_transcript", record), []);
});

test("identity context injects confirmed people but leaves project ownership to later reasoning", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-context-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON",
    status: "confirmed", aliases: [], evidenceRefs: []
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "200",
    participantLinks: [{ participantId: "participant-cotton", status: "confirmed", confidence: 1, evidenceRefs: [] }]
  });
  const record: GroupMessageRecord = {
    time: 1, groupId: 100, userId: 200, rawMessage: "边缘空间可以这样做", messageId: "m-2", senderName: "COTTON", instanceId: "qq-main"
  };
  const context = identityContextForForward(roleDir, "group_message", record, { gatewayId: "profile-current", routeProfileId: "profile-current" });
  const lines = identityContextLines(context).join("\n");
  assert.match(lines, /已确认参与者：COTTON/);
  assert.match(lines, /不能单独证明项目归属、委托、决策权或执行授权/);
});

test("shared accounts expose possible users and confirmed speaking habits without forcing a unique person", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-shared-context-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-liu", participantKind: "person", displayName: "刘云云",
    status: "confirmed", aliases: [], evidenceRefs: [],
    speakingHabits: [{ dimension: "sentence_opening", description: "习惯先给结论", confidence: 0.8, evidenceRefs: [{ messageId: "liu-known" }] }]
  });
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-zhu", participantKind: "person", displayName: "猪皮糕糕",
    status: "confirmed", aliases: [], evidenceRefs: []
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "300",
    displayName: "lovegd", participantLinks: [
      { participantId: "participant-liu", status: "candidate", confidence: 0.5, evidenceRefs: [{ messageId: "shared-account-proof" }] },
      { participantId: "participant-zhu", status: "candidate", confidence: 0.5, evidenceRefs: [{ messageId: "shared-account-proof" }] }
    ]
  });
  const record: GroupMessageRecord = {
    time: 1, groupId: 100, userId: 300, rawMessage: "先说结论，这个要回归一下。", messageId: "shared-message", senderName: "lovegd", instanceId: "qq-main"
  };

  const context = identityContextForForward(roleDir, "group_message", record);
  const lines = identityContextLines(context).join("\n");
  assert.equal(context?.confirmedParticipant, undefined);
  assert.equal(context?.possibleParticipants.length, 2);
  assert.match(lines, /可能使用者：刘云云/);
  assert.match(lines, /句首习惯=习惯先给结论/);
  assert.match(lines, /说话习惯一致性/);
  assert.match(lines, /不能把情境推断改写成永久的一对一账号映射/);
});
