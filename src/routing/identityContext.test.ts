import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FeishuMessageRecord, GroupMessageRecord, WeComMessageRecord, WeixinMessageRecord } from "../history.js";
import { updateIdentityRelation } from "../identityRelations.js";
import { identityContextForForward, identityContextLines, identityEndpointForForward } from "./identityContext.js";

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
