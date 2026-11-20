import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { withTestEndpointEgress } from "../endpointEgress.fixture.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import type { NativeOwnerDelivery } from "../agentRequests/nativeOwnerDelivery.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { agentDeliveryPromptHash } from "../agentRequests/state.js";
import { AgentCompletionDeliveryService, deliverCompletionToEndpoint, type CompletionRuleOwner } from "../manager/agentCompletionDelivery.js";
import type { CodexHookContextRequest } from "../manager/codexHookContext.js";
import { agentHookRuleErrors, normalizeAgentCompletionDeliveries, originalChatChannel } from "../shared/agentHookAutomation.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";
import { assertOriginalChatRoute, bindOriginalChatTurn, bindPeerOriginalChatCompletion, originalChatFromIngress, originalChatPeerCompletion,
  readOriginalChat, registerOriginalChat, savePeerOriginalChatAdmission } from "./originalChat.js";

const ingress = {
  gatewayId: "gateway-original", routeProfileId: "profile-original", roleId: "role-1", botUserId: "456",
  instanceId: "qq-original", targetType: "group", groupId: "123", userId: "789", messageId: "input-1"
};
const chat = originalChatFromIngress(ingress, undefined)!;
const callerId = "automation-fixture";
const receiptId = "agent-" + "a".repeat(64);
const fullSessionId = "provider-original-session-full";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-original-chat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function dispatch(root: string, agentType: string, state: PreparedEndpointDelivery["state"] = "dispatching", options: {
  node?: string; device?: string; caller?: string; id?: string; destination?: typeof chat;
} = {}) {
  const id = options.id ?? receiptId;
  const caller = options.caller ?? callerId;
  const instance = options.node ? { instanceId: options.node, agentId: "local:" + agentType,
    ...(options.device ? { ownerDeviceId: options.device } : {}) } : undefined;
  const target = { agentType, sessionId: fullSessionId, instance };
  const control = registerOriginalChat(root, caller, options.destination ?? chat, target)!;
  const prompt = renderRabiDelivery({
    messageSource: { type: "system", eventId: "fixture", eventType: "fixture", eventName: "fixture" },
    messageContent: "original input",
    controlBlocks: [control, "[回传参数]\n" + JSON.stringify({ deliveryId: id, responsePolicy: "none" })]
  });
  const endpoint: AgentRequestEndpoint = { kind: instance ? "instance" : "local", ...instance,
    managerInstanceId: "manager-origin", nodeId: instance?.instanceId, agentId: "local:" + agentType,
    provider: agentType, sessionId: fullSessionId, authorizationIncarnation: "auth:" + (instance?.instanceId ?? "local") };
  const receipt = {
    state, callerDeliveryId: caller, deliveryId: id, generation: "generation:" + id, prompt, promptHash: agentDeliveryPromptHash(prompt), target: endpoint
  } as PreparedEndpointDelivery;
  return { ...target, turnId: "native-turn-01", prompt, receipt, read: async (observed: string) => observed === id ? receipt : undefined };
}

test("an original-chat destination saves without a fixed Route and accepts only completion", () => {
  const [rule] = normalizeAgentCompletionDeliveries([{ id: "auto-reply", enabled: true,
    event: "task_completed", conditions: [], destination: { channel: originalChatChannel, gatewayId: "", params: {} } }]);
  assert.equal(rule.destination.channel, originalChatChannel);
  assert.equal(rule.destination.gatewayId, "");
  assert.deepEqual(agentHookRuleErrors(rule, "dsh"), []);
  assert.deepEqual(agentHookRuleErrors({ ...rule, event: "task_progress" }, "dsh"), ["回原聊天仅支持任务完成。"]);
});

test("capture exact original account, route, sender, chat, and source message for each connector", () => {
  assert.deepEqual(chat, {
    gatewayId: "gateway-original", routeId: "profile-original", roleId: "role-1", channel: "napcat", account: "456",
    conversationId: "123", senderId: "789", messageId: "input-1",
    params: { target: "group", groupId: "123", instanceId: "qq-original" }
  });
  assert.equal(originalChatFromIngress({ ...ingress, instanceId: "" }, undefined), undefined);
  const qqbot = { ...ingress, adapterType: "qqbot", messageId: "qqbot-input-1", qqbotCanReply: true };
  assert.deepEqual(originalChatFromIngress(qqbot, undefined)?.params, { sourceMessageId: "qqbot-input-1" });
  assert.equal(originalChatFromIngress({ ...qqbot, qqbotCanReply: false }, undefined), undefined);
  const weixin = { ...ingress, adapterType: "weixin", weixinSessionId: "wx-session", weixinUserId: "wx-user" };
  assert.deepEqual(originalChatFromIngress(weixin, "bot:sync-1")?.params, { sessionId: "wx-session", userId: "wx-user" });
  assert.equal(originalChatFromIngress(weixin, undefined), undefined);
  assert.deepEqual(originalChatFromIngress({ ...ingress, adapterType: "wecom", wecomChatId: "room", wecomReqId: "request" }, "bot:wecom")?.params,
    { chatId: "room", userId: "789", reqId: "request" });
  assert.deepEqual(originalChatFromIngress({ ...ingress, adapterType: "feishu", feishuChatId: "oc_fixture" }, "app")?.params,
    { chatId: "oc_fixture", userId: "789" });
  assert.equal(originalChatFromIngress({ ...ingress, targetType: "manual_trigger" }, undefined), undefined);
});

for (const agent of ["codex", "dsh", "workbuddy"]) {
  test(agent + " binds only the exact original input once and resolves it after restart", async t => {
    const root = fixture(t);
    const run = dispatch(root, agent);
    assert.equal(readOriginalChat(root, run, chat.roleId), undefined);
    for (const invalid of [
      { ...run, prompt: "manual" },
      { ...run, prompt: run.prompt.replace("original input", "different input") },
      { ...run, sessionId: "other-session" },
      { ...run, sourceInstance: { instanceId: "elsewhere" } }
    ]) await bindOriginalChatTurn(root, invalid, run.read);
    await bindOriginalChatTurn(root, run, async () => ({ ...run.receipt, state: "prepared" }));
    assert.equal(readOriginalChat(root, run, chat.roleId), undefined);
    await Promise.all([bindOriginalChatTurn(root, run, run.read), bindOriginalChatTurn(root, run, run.read)]);
    assert.deepEqual(readOriginalChat(root, run, chat.roleId), { ...chat, receiptId });
    assert.equal(readOriginalChat(root, run, "elsewhere"), undefined);
    await bindOriginalChatTurn(root, { ...run, turnId: "manual-later" }, run.read);
    assert.equal(readOriginalChat(root, { ...run, turnId: "manual-later" }, chat.roleId), undefined);
    assert.equal(readOriginalChat(root, { ...run, turnId: undefined }, chat.roleId), undefined);
    assert.throws(() => registerOriginalChat(root, callerId, { ...chat, gatewayId: "replacement" }, {
      agentType: run.agentType, sessionId: run.sessionId
    }), /identity changed/);
  });
}

test("legacy replays do not establish new sources and the existing source remains stable", t => {
  const root = fixture(t);
  const target = { agentType: "codex", sessionId: fullSessionId };
  assert.equal(registerOriginalChat(root, callerId, chat, target, true), undefined);
  const original = registerOriginalChat(root, callerId, chat, target);
  assert.equal(registerOriginalChat(root, callerId, undefined, target, true), original);
});

test("original completion and fixed delivery deduplicate the actual chat; manual completion only sends the fixed rule", async t => {
  const root = fixture(t);
  const run = dispatch(root, "codex", "committed");
  await bindOriginalChatTurn(root, run, run.read);
  const source: CompletionRuleOwner = { roleId: chat.roleId, rule: { id: "original", event: "task_completed",
    enabled: true, conditions: [], destination: { channel: originalChatChannel, gatewayId: "", params: {} } } };
  const fixed: CompletionRuleOwner = { ...source, rule: { ...source.rule, id: "fixed",
    destination: { channel: "napcat", gatewayId: chat.gatewayId, params: { instanceId: chat.params.instanceId, target: "group", targetId: "123" } } } };
  const sent = new Map<string, string>();
  const service = new AgentCompletionDeliveryService({
    rules: () => [source, fixed],
    resolveOriginalChat: ({ roleId }, request) => readOriginalChat(root, request, roleId),
    async deliver({ rule }, _hook, id, context) {
      if (!sent.has(id)) sent.set(id, rule.id);
      if (rule.id === "original") assert.deepEqual(context.originalChat, { ...chat, receiptId });
    }
  });
  const stop: CodexHookContextRequest = { eventName: "Stop", agentType: run.agentType, sessionId: fullSessionId,
    turnId: run.turnId, lastAssistantMessage: "Done" };
  assert.deepEqual(await service.handle(stop), [{ ruleId: "original", status: "sent" }]);
  await service.handle(stop);
  assert.deepEqual([...sent.values()], ["original"]);
  const manual = await service.handle({ ...stop, turnId: "manual-turn" });
  assert.deepEqual(manual.map(item => [item.ruleId, item.status]), [["original", "skipped"], ["fixed", "sent"]]);
  assert.deepEqual([...sent.values()], ["original", "fixed"]);
});


test("signed LAN hooks with identical session and turn IDs resolve only their own node and original route", async t => {
  const root = fixture(t);
  const first = dispatch(root, "codex", "dispatching", { node: "lan-a" });
  const secondChat = { ...chat, gatewayId: "gateway-b", routeId: "profile-b" };
  const second = dispatch(root, "codex", "dispatching", { node: "lan-b", caller: "automation-b",
    id: "agent-" + "b".repeat(64), destination: secondChat });
  const observed = (node: string, run: typeof first) => ({ ...run, sourceInstance: { instanceId: node },
    trustedRemoteSource: { nodeId: node, agentId: "host-agent", provider: "codex" as const, sessionId: run.sessionId,
      authorizationIncarnation: "auth:" + node } });
  const a = observed("lan-a", first);
  const b = observed("lan-b", second);
  await bindOriginalChatTurn(root, observed("lan-b", first), first.read);
  await bindOriginalChatTurn(root, { ...a, trustedRemoteSource: { ...a.trustedRemoteSource, authorizationIncarnation: "rotated" } }, first.read);
  assert.equal(readOriginalChat(root, a, chat.roleId), undefined);
  assert.equal(readOriginalChat(root, b, chat.roleId), undefined);
  await Promise.all([bindOriginalChatTurn(root, a, first.read), bindOriginalChatTurn(root, b, second.read)]);
  assert.equal(readOriginalChat(root, a, chat.roleId)?.routeId, chat.routeId);
  assert.equal(readOriginalChat(root, b, chat.roleId)?.routeId, secondChat.routeId);
  assert.equal(readOriginalChat(root, first, chat.roleId), undefined);
});

test("authenticated Peer lifecycle returns one exact prepared intent and leaves queued and manual turns unbound", async t => {
  const source = fixture(t);
  const peer = fixture(t);
  const run = dispatch(source, "dsh", "dispatching", { node: "native-peer-manager", device: "pc-peer" });
  savePeerOriginalChatAdmission(peer, "pc-original", run.receipt as unknown as NativeOwnerDelivery);
  const noOrigin = async () => undefined;
  const oldTurn = { ...run, prompt: "already running", turnId: "old-native-turn", lastAssistantMessage: "old text" };
  await bindOriginalChatTurn(peer, oldTurn, noOrigin);
  assert.equal(originalChatPeerCompletion(peer, oldTurn), undefined);
  await bindOriginalChatTurn(peer, { ...run, prompt: run.prompt.replace("original input", "different") }, noOrigin);
  assert.equal(originalChatPeerCompletion(peer, { ...run, lastAssistantMessage: "wrong hash" }), undefined);
  await bindOriginalChatTurn(peer, run, noOrigin);
  const proof = originalChatPeerCompletion(peer, { ...run, lastAssistantMessage: "completed original" })!;
  assert.equal(proof.deviceId, "pc-original");
  assert.equal(await bindPeerOriginalChatCompletion(source, "other-pc", proof.proof, run.read), undefined);
  assert.equal(await bindPeerOriginalChatCompletion(source, "pc-peer", { ...proof.proof, generation: "replaced" }, run.read), undefined);
  const matched = await bindPeerOriginalChatCompletion(source, "pc-peer", proof.proof, run.read);
  assert.equal(matched?.turn.sourceInstance?.instanceId, "native-peer-manager");
  assert.equal(matched?.turn.sourceInstance?.ownerDeviceId, "pc-peer");
  assert.equal(matched?.chat.routeId, chat.routeId);
  assert.equal(await bindPeerOriginalChatCompletion(source, "pc-peer", { ...proof.proof, turnId: "manual-next" }, run.read), undefined);
  await bindOriginalChatTurn(peer, { ...run, turnId: "manual-next" }, noOrigin);
  assert.equal(originalChatPeerCompletion(peer, { ...run, turnId: "manual-next", lastAssistantMessage: "manual text" }), undefined);
});

test("a moved Route and a replaced message account cannot receive the original completion", () => {
  assert.doesNotThrow(() => assertOriginalChatRoute(chat, chat));
  for (const current of [undefined, { ...chat, gatewayId: "different" }, { ...chat, routeId: "different" }, { ...chat, roleId: "different" }]) {
    assert.throws(() => assertOriginalChatRoute(chat, current), /路线已变更/);
  }
  assert.throws(() => assertOriginalChatRoute(chat, { ...chat, account: "relogged" }), /账号当前不可用或已切换/);
});

test("original Outbox uses the exact profile and account and keeps the same receipt across restarts", async t => {
  const rootDir = fixture(t);
  const received: Array<{ path?: string; data: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", data => { body += data; });
    request.on("end", () => {
      const data = JSON.parse(body);
      received.push({ path: request.url, data });
      if (data.message === "uncertain") { response.destroy(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 999 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const options = withTestEndpointEgress({
    rootDir, routeRoot: path.join(rootDir, "route"), rolesRoot: path.join(rootDir, "roles"),
    runtimes: [{ id: chat.gatewayId, routeProfiles: [{ id: "different-profile" }, { id: chat.routeId }],
      napcatInstances: [{ id: chat.params.instanceId, httpUrl: "http://127.0.0.1:" + address.port, accessToken: "" }] }]
  });
  const rule = { id: "original", event: "task_completed", enabled: true, conditions: [],
    destination: { channel: originalChatChannel, gatewayId: "", params: { includeAgentType: "false", includeTaskName: "false" } } };
  const stop: CodexHookContextRequest = { eventName: "Stop", agentType: "codex", turnId: "turn", sessionId: fullSessionId, lastAssistantMessage: "done" };
  for (const _repeat of [1, 2]) {
    await deliverCompletionToEndpoint(rule, stop, "original-receipt", chat.routeId, options, { plans: [], originalChat: chat });
  }
  assert.deepEqual(received.map(item => [item.path, item.data.group_id, item.data.message]), [["/send_group_msg", 123, "done"]]);
  await assert.rejects(() => deliverCompletionToEndpoint(rule, { ...stop, lastAssistantMessage: "changed" }, "original-receipt",
    chat.routeId, options, { plans: [], originalChat: chat }));
  assert.equal(received.length, 1);
  const uncertain = { ...stop, turnId: "uncertain-turn", lastAssistantMessage: "uncertain" };
  for (const _repeat of [1, 2]) {
    await assert.rejects(() => deliverCompletionToEndpoint(rule, uncertain, "uncertain-receipt",
      chat.routeId, options, { plans: [], originalChat: chat }));
  }
  assert.equal(received.length, 2, "an uncertain completion never calls the platform again");
});
