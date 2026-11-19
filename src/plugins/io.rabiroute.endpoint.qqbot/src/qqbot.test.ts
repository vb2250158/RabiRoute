import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "@rabiroute/host-api/manager/managerPluginRouteRegistry";
import { createGatewayListenerRuntime } from "@rabiroute/host-api/runtime/gatewayListenerRuntime";
import { handleAgentSend, type AgentSendRequest } from "@rabiroute/host-api/agentSend";
import { agentSendRequestTemplateForSource } from "../../../agentSendTemplate.js";
import { appendQqBotMessageToDir, type QqBotMessageRecord } from "@rabiroute/host-api/history";
import { defaultMessageAdapterNotificationRules } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { createBotAccounts } from "./accounts.js";
import { createQqBotEndpoint } from "./gateway.js";
import { createBotOperations } from "./manager.js";
import { botSigningKey, createBotApi } from "./protocol.js";

const credentials = { appId: "123456789", appSecret: "fixture-credential-for-testing", sandbox: true };

function tempRoot(t: { after(callback: () => void): void }) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "rabi-qqbot-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("QQ Bot account API checks the Manager fence, stores one protected account and revokes it", async t => {
  const root = tempRoot(t);
  const accounts = createBotAccounts(root);
  const registry = new ManagerPluginRouteRegistry();
  let checked = 0;
  const api = createBotApi(async (url, options) => {
    assert.equal(url, "https://bots.qq.com/app/getAppAccessToken");
    assert.deepEqual(JSON.parse(String(options?.body)), { appId: credentials.appId, clientSecret: credentials.appSecret });
    checked++;
    return Response.json({ access_token: "fixture-token", expires_in: "7200" });
  });
  const fence = { applicationGenerationId: "test-generation", managerInstanceId: "test-manager" };
  const registration = await registry.registerOperationsAsync("qqbot", createBotOperations(accounts, api,
    { lifecycleFence: fence, readOnly: false, access: () => true }, new AbortController().signal), new AbortController().signal);
  const server = http.createServer((req, res) => {
    if (!registry.handle(req, new URL(req.url!, "http://localhost"), res)) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/message/qqbot/accounts`;
  const headers = { "content-type": "application/json", "idempotency-key": "qqbot-fixture-create",
    "x-rabiroute-expected-application-generation-id": fence.applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": fence.managerInstanceId };
  const body = JSON.stringify(credentials);
  const stale = await fetch(url, { method: "POST", headers: { ...headers, "x-rabiroute-expected-manager-instance-id": "old" }, body });
  assert.equal(stale.status, 409);
  const saved = await fetch(url, { method: "POST", headers, body });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  const account = payload.data;
  assert.equal(account.state, "connected");
  const repeated = await fetch(url, { method: "POST", headers, body });
  assert.deepEqual(await repeated.json(), payload);
  assert.equal(checked, 1);
  assert.equal(createBotAccounts(root).credentials(account.id)?.appSecret, credentials.appSecret);
  for (const entry of [JSON.stringify(payload), await (await fetch(url)).text(), fs.readFileSync(path.join(root, "data/.runtime/qqbot/accounts.json"), "utf8")]) {
    assert.ok(!entry.includes(credentials.appSecret));
    assert.ok(!entry.includes("fixture-token"));
  }
  const logout = await fetch(url + "/" + account.id + "/auth", {
    method: "DELETE", headers: { ...headers, "idempotency-key": "qqbot-fixture-logout" }, body: JSON.stringify({ revision: account.revision })
  });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).data.state, "authorization_required");
  assert.equal(accounts.credentials(account.id), undefined);
});

test("QQ Bot local callback verifies challenges and event signatures, deduplicates, and keeps OpenIDs distinct", async t => {
  const root = tempRoot(t);
  const accounts = createBotAccounts(root);
  const account = accounts.update({ requestId: "fixture-credentials", credentials });
  const listeners = createGatewayListenerRuntime({ identity: { gatewayId: "fixture-route", gatewayGenerationId: "fixture", pid: process.pid }, publish() {} });
  const received: Array<{ kind: string; record: QqBotMessageRecord }> = [];
  const dispose = await createQqBotEndpoint({
    settings: { qqbotAccountId: account.id, dataDir: root }, accounts: () => accounts, listeners: () => listeners,
    gatewayId: () => "fixture-route", deliver: (kind, record) => {
      assert.ok("accountRevision" in record);
      received.push({ kind, record });
    }
  }).start();
  t.after(async () => { await dispose?.(); await listeners.dispose(); });
  const address = listeners.listenerAddress("qqbot.callback");
  assert.ok(address);
  const readConnection = () => JSON.parse(fs.readFileSync(path.join(root, "gateway-status.json"), "utf8")).messageAdapters.qqbot;
  assert.equal(readConnection().accountId, account.id);
  assert.equal(readConnection().connected, true);
  const url = `http://127.0.0.1:${address.port}/qqbot`;
  const key = botSigningKey(credentials.appSecret);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const challenge = await fetch(url, { method: "POST", headers: { "x-bot-appid": credentials.appId },
    body: JSON.stringify({ op: 13, d: { plain_token: "fixture-token", event_ts: timestamp } }) });
  assert.equal(challenge.status, 200);
  const signedChallenge = await challenge.json();
  assert.ok(verify(null, Buffer.from(timestamp + signedChallenge.plain_token), key.publicKey, Buffer.from(signedChallenge.signature, "hex")));

  const c2c = { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "message-private", author: { user_openid: "user-private" }, content: "hello" } };
  const group = { op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "message-group", group_openid: "group-openid", author: { member_openid: "user-group" }, content: "world" } };
  const post = (data: object, { valid = true, appId = credentials.appId } = {}) => {
    const body = JSON.stringify(data);
    const signature = valid ? sign(null, Buffer.from(timestamp + body), key.privateKey).toString("hex") : "0".repeat(128);
    return fetch(url, { method: "POST", body, headers: {
      "x-bot-appid": appId, "x-signature-timestamp": timestamp, "x-signature-ed25519": signature
    } });
  };
  assert.equal((await post(c2c, { valid: false })).status, 403);
  assert.equal((await post(group, { appId: "987654321" })).status, 403);
  assert.deepEqual(await (await post(c2c)).json(), { op: 12 });
  assert.equal((await post(c2c)).status, 200);
  assert.equal((await post(group)).status, 200);
  assert.deepEqual(received.map(({ kind, record }) => [kind, record.groupId, record.userId]), [
    ["qqbot_private", undefined, "user-private"], ["qqbot_group", "group-openid", "user-group"]
  ]);
  assert.equal(fs.readFileSync(path.join(root, "qqbot-messages.jsonl"), "utf8").trim().split("\n").length, 2);
  accounts.update({ id: account.id, expected: account.revision, requestId: "fixture-logout" });
  assert.equal((await post(group)).status, 403);
  for (let attempt = 0; attempt < 40 && readConnection().connected; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(readConnection().connected, false);
});

test("QQ Bot sends only the original group or user message through the selected account", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const api = createBotApi(async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url).endsWith("getAppAccessToken")
      ? Response.json({ access_token: "fixture-token", expires_in: 7200 })
      : Response.json({ id: "reply-receipt" });
  });
  const group = { groupId: "group-openid", userId: "member-openid", platformMessageId: "group-message" };
  const c2c = { userId: "user-openid", platformMessageId: "private-message" };
  const current = () => {};
  assert.equal((await api.reply(credentials, "revision", group, "group text", current)).messageId, "reply-receipt");
  assert.equal((await api.reply(credentials, "revision", c2c, "private text", current)).messageId, "reply-receipt");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, "https://sandbox.api.sgroup.qq.com/v2/groups/group-openid/messages");
  assert.equal(calls[2].url, "https://sandbox.api.sgroup.qq.com/v2/users/user-openid/messages");
  assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { msg_type: 0, msg_id: "group-message", msg_seq: 1, content: "group text" });
  await assert.rejects(api.reply(credentials, "revision", c2c, "revoked", () => { throw new Error("revoked"); }), /revoked/);
  assert.equal(calls.length, 3);
});

test("Agent source reply resolves only the originating Route, account and conversation", async t => {
  const root = tempRoot(t);
  const record: QqBotMessageRecord = {
    adapterType: "qqbot", gatewayId: "route-a", instanceId: "bot-a", accountRevision: "revision-a",
    userId: "member-openid", groupId: "group-openid", messageId: "qqbot-fixture", platformMessageId: "qq-source",
    time: 1700000000, rawMessage: "hello"
  };
  assert.deepEqual(defaultMessageAdapterNotificationRules(["qqbot"])[0].routeKinds, ["qqbot_private", "qqbot_group", "qqbot_channel", "qqbot_dm"]);
  appendQqBotMessageToDir(record, root);
  const template = agentSendRequestTemplateForSource({ routeProfileId: record.gatewayId, adapterType: "qqbot", targetType: "group", messageId: record.messageId });
  assert.equal(template?.channel, "qqbot");
  assert.deepEqual(template?.params, { sourceMessageId: record.messageId });
  const request: AgentSendRequest = {
    deliveryId: "fixture-qqbot-reply", sender: { agentType: "primary_persona", sessionId: "fixture" }, routeId: "route-a",
    channel: "qqbot", params: { sourceMessageId: record.messageId }, payload: { type: "text", text: "reply" }
  };
  let sendCount = 0;
  const provider = {
    acquire: () => ({
      async call<T>(operation: string, args: readonly unknown[]) {
        assert.equal(operation, "reply");
        assert.deepEqual(args, [record, "reply"]);
        sendCount++;
        return { messageId: "receipt" } as T;
      },
      release() {}
    })
  } as unknown as MessageEndpointEgressProvider;
  const runtime = { id: record.gatewayId, dataDir: root, messageAdapters: ["qqbot"], qqbotAccountId: record.instanceId };
  const options = { rootDir: root, routeRoot: root, rolesRoot: root, runtimes: [runtime], endpointEgress(capability: string) {
    assert.equal(capability, "endpoint.qqbot.egress@1"); return provider;
  } };
  assert.equal((await handleAgentSend(request, options)).status, "sent");
  assert.equal((await handleAgentSend({ ...request, routeId: "route-b" }, { ...options, runtimes: [runtime, { ...runtime, id: "route-b" }] })).status, "blocked");
  assert.equal((await handleAgentSend(request, { ...options, runtimes: [{ ...runtime, qqbotAccountId: "bot-b" }] })).status, "blocked");
  assert.equal((await handleAgentSend(request, { ...options, runtimes: [{ ...runtime, messageAdapterPolicies: { qqbot: { outputEnabled: false } } }] })).status, "blocked");
  assert.equal(sendCount, 1);
});
