import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "@rabiroute/host-api/manager/managerPluginRouteRegistry";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createBotAccounts } from "./accounts.js";
import { botCapabilities } from "./catalog.js";
import { parseLargeFile, uploadLargeFile } from "./media.js";
import { createBotPlatformOperations } from "./platform.js";
import { createBotApi, decodeBotDispatch, qqbotRouteKind } from "./protocol.js";
import { runBotSocket } from "./socket.js";

const credentials = { appId: "123456789", appSecret: "fixture-test-secret", sandbox: true };
const account = { id: "fixture", revision: "revision-1", ...credentials };

test("all four messaging scopes and ordinary platform events retain their native identity", () => {
  const event = (t: string, d: object) => decodeBotDispatch({ op: 0, t, id: "fixture-event", d }, account, "route", Date.now())!;
  const group = event("GROUP_MESSAGE_CREATE", { id: "group-message", group_openid: "group", author: { member_openid: "member" }, content: "a" });
  assert.equal(qqbotRouteKind(group), "qqbot_group");
  const channel = event("MESSAGE_CREATE", { id: "channel-message", guild_id: "200", channel_id: "100", author: { id: "member" },
    attachments: [{ url: "//multimedia.nt.qq.com.cn/download?fixture=1", content_type: "image/png", filename: "test.png" }] });
  assert.equal(qqbotRouteKind(channel), "qqbot_channel");
  assert.match(channel.rawMessage, /test\.png/);
  assert.deepEqual(channel.remoteAttachments?.map(x => x.url), ["https://multimedia.nt.qq.com.cn/download?fixture=1"]);
  const dm = event("DIRECT_MESSAGE_CREATE", { id: "dm", guild_id: "300", src_guild_id: "200", channel_id: "100", author: { id: "member" }, content: "b" });
  assert.equal(qqbotRouteKind(dm), "qqbot_dm");
  assert.deepEqual([dm.dmGuildId, dm.guildId], ["300", "200"]);
  const interaction = event("INTERACTION_CREATE", { id: "click", group_openid: "group", type: 11 });
  assert.equal(qqbotRouteKind(interaction), "qqbot_event");
  assert.equal(interaction.platformMessageId, "");
  assert.equal(interaction.eventId, "fixture-event");
});

test("the platform catalog compiles, resolves an exact Route and preserves a single native mutation receipt", async t => {
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "qqbot-platform-fixture-"));
  const registry = new ManagerPluginRouteRegistry();
  const accounts = createBotAccounts(root);
  const saved = accounts.update({ requestId: "fixture-account-create", credentials });
  const production = accounts.update({ requestId: "fixture-production-create", credentials: { ...credentials, sandbox: false } });
  assert.notEqual(saved.id, production.id);
  assert.throws(() => accounts.update({ requestId: "fixture-duplicate-create", credentials }), /所选环境已有账号/);
  const fence = { applicationGenerationId: "fixture-gen", managerInstanceId: "fixture-manager" };
  const route: GatewayDefinition = { id: "fixture-route", gatewayPort: 0, messageAdapters: ["qqbot"], qqbotAccountId: saved.id };
  const calls: Array<{ url: string; params?: RequestInit }> = [];
  const api = createBotApi(async (url, params) => {
    calls.push({ url: String(url), params });
    return String(url).includes("getAppAccessToken")
      ? Response.json({ access_token: "fixture-token", expires_in: 7200 })
      : Response.json({ id: "native-qq-receipt" }, { headers: { "x-tps-trace-id": "qq-trace" } });
  });
  const definitions = createBotPlatformOperations(accounts, api,
    { rootDir: root, readOnly: false, access: () => true, lifecycleFence: fence, readRoute: id => id === route.id ? route : undefined },
    new AbortController().signal);
  assert.equal(definitions.length, botCapabilities.length + 1);
  const registration = await registry.registerOperationsAsync("endpoint:qqbot", definitions, new AbortController().signal);
  const server = http.createServer((req, res) => {
    if (!registry.handle(req, new URL(req.url!, "http://localhost"), res)) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await registration.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/message/qqbot/routes/`;
  const base = origin + route.id + "/platform";
  const headers = { "content-type": "application/json", "idempotency-key": "qqbot-fixture-send",
    "x-rabiroute-expected-application-generation-id": fence.applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": fence.managerInstanceId };
  const request = { method: "POST", headers, body: JSON.stringify({ msg_type: 2, markdown: { content: "fixture" } }) };
  assert.equal((await fetch(origin + "wrong/platform/send_group/group-1", request)).status, 404);
  assert.equal((await fetch(base + "/send_group/%2E%2E%2Ftarget", request)).status, 400);
  assert.equal((await fetch(base + "/send_group/group-1", { ...request, headers: { ...headers,
    "x-rabiroute-expected-manager-instance-id": "previous" } })).status, 409);
  assert.equal(calls.length, 0);
  const first = await fetch(base + "/send_group/group-1", request);
  assert.equal(first.status, 200, await first.clone().text());
  const firstReceipt = (await first.json()).data;
  assert.equal(firstReceipt.result.data.id, "native-qq-receipt");
  const duplicate = await fetch(base + "/send_group/group-1", request);
  assert.equal((await duplicate.json()).data.duplicate, true);
  assert.equal((await fetch(base + "/send_group/group-2", request)).status, 409);
  const receipt = await fetch(base + "/receipts/qqbot-fixture-send");
  assert.equal((await receipt.json()).data.result.traceId, "qq-trace");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://sandbox.api.sgroup.qq.com/v2/groups/group-1/messages");
  assert.equal(JSON.parse(String(calls[1].params?.body)).msg_type, 2);
  assert.equal((await fetch(base + "/members/guild-1?limit=20")).status, 200);
  assert.equal(calls[2].url, "https://sandbox.api.sgroup.qq.com/guilds/guild-1/members?limit=20");

  const write = (operation: string, id: string, method = "POST") => fetch(base + "/" + operation, {
    method, headers: { ...headers, "idempotency-key": "qqbot-fixture-" + id }, body: "{}"
  });
  route.messageAdapterPolicies = { qqbot: { outputEnabled: false } };
  assert.equal((await write("send_group/group-1", "output-disabled")).status, 403);
  assert.equal((await write("channel_create/guild-1", "management-allowed")).status, 200);
  route.messageAdapterPolicies = {};
  route.qqbotManagementEnabled = false;
  assert.equal((await write("channel_create/guild-1", "management-disabled")).status, 403);
  assert.equal((await write("send_group/group-1", "output-allowed")).status, 200);
  route.messageAdapterPolicies = { qqbot: { outputEnabled: false } };
  assert.equal((await write("interaction_ack/interaction-1", "interaction-ack", "PUT")).status, 200);
});

test("WebSocket performs Hello, Identify and READY before dispatching a signed-account event", async () => {
  const calls: object[] = [];
  const scope = new AbortController();
  const api = createBotApi(async url => String(url).includes("getAppAccessToken")
    ? Response.json({ access_token: "fixture-token", expires_in: 7200 })
    : Response.json({ url: "wss://fixture.qq.com/gateway" }));
  class FakeSocket extends EventTarget {
    readyState = 1;
    send(raw: string) { calls.push(JSON.parse(raw)); }
    close() {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
    }
    emit(data: object, binary = false) {
      const json = JSON.stringify(data);
      this.dispatchEvent(new MessageEvent("message", { data: binary ? new TextEncoder().encode(json).buffer : json }));
    }
  }
  const received: string[] = [];
  await runBotSocket({ account: () => account, watchAccount: () => () => {}, api, gatewayId: "fixture", intents: 33554432, signal: scope.signal,
    report() {}, accept(record) { received.push(record.rawMessage); scope.abort(); },
    connect(url) {
      assert.equal(url, "wss://fixture.qq.com/gateway");
      const socket = new FakeSocket();
      queueMicrotask(() => {
        socket.emit({ op: 10, d: { heartbeat_interval: 1500 } });
        socket.emit({ op: 0, t: "READY", s: 1, d: { session_id: "fixture-session" } });
        socket.emit({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: { id: "msg", author: { user_openid: "fixture-user" }, content: "fixture" } }, true);
      });
      return socket as unknown as WebSocket;
    }
  });
  assert.deepEqual(received, ["fixture"]);
  assert.equal((calls[0] as { op: number }).op, 2);
});

test("managed media uploads native parts and completes with a reusable QQ file receipt", async () => {
  const put: string[] = [];
  const operations: string[] = [];
  const file = parseLargeFile({ name: "sample.txt", fileType: 4, base64: Buffer.from("abcde").toString("base64") });
  const result = await uploadLargeFile("/v2/groups/test", file, async (url, body) => {
    operations.push(url);
    if (url.endsWith("upload_prepare")) return { status: 200, data: { upload_id: "session", block_size: 3,
      parts: [{ index: 1, presigned_url: "https://uploads.example.test/1" }, { index: 2, presigned_url: "https://uploads.example.test/2" }] } };
    if (url.endsWith("upload_part_finish")) {
      assert.equal(body.upload_id, "session");
      return { status: 204, data: null };
    }
    assert.deepEqual(body, { upload_id: "session" });
    return { status: 200, data: { file_info: "opaque-file-info" } };
  }, () => {}, new AbortController().signal, async (_, init) => {
    put.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(put, ["abc", "de"]);
  assert.equal(operations.length, 4);
  assert.deepEqual(result.data, { file_info: "opaque-file-info" });
});
