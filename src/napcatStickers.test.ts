import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNapCatStickers, readNapCatStickers } from "./napcatStickers.js";
import { prepareAgentSendRequest, handleAgentSend } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";

const id = "0123456789abcdef0123456789abcdef";
const url = `https://p.qpic.cn/qq_expression/account/${id}/0`;
test("favorite IDs survive rotated media credentials; unsupported references are omitted", () => {
  const parsed = parseNapCatStickers([url + "?rkey=private", { url: url + "?rkey=new", md5: id.toUpperCase(), desc: "谢谢" },
    { url: `file:///private/${id}`, md5: id }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.id, id);
  assert.equal(parsed[0]!.description, "谢谢");
});

test("favorite resources accept NapCat supplied CDN domains and explicit ports", () => {
  for (const host of ["multimedia.nt.qq.com.cn", "cdn.example:8443", "127.0.0.1:43210"]) {
    const value = `http://${host}/${id}`;
    assert.equal(parseNapCatStickers([{ url: value, md5: id }])[0]?.url, value);
  }
});

test("favorite parsing retains all items actually returned by NapCat", () => {
  const entries = Array.from({ length: 1001 }, (_, index) => ({ md5: index.toString(16).padStart(32, "0"), url: `https://cdn.example/${index}` }));
  assert.equal(parseNapCatStickers(entries).length, entries.length);
});
test("old NapCat uses basic favorite reads only after explicit unsupported action", async () => {
  const actions: string[] = [];
  const transport = (async (input: unknown) => {
    const action = String(input).split("/").pop()!; actions.push(action);
    return Response.json(action === "fetch_custom_face_detail"
      ? { status: "failed", retcode: 200, message: "不支持的Api fetch_custom_face_detail" }
      : { status: "ok", retcode: 0, data: [url] });
  }) as typeof fetch;
  assert.equal((await readNapCatStickers({ httpUrl: "http://127.0.0.1:1234", accessToken: "" }, 48, transport))[0]!.id, id);
  assert.deepEqual(actions, ["fetch_custom_face_detail", "fetch_custom_face"]);
  let calls = 0;
  await assert.rejects(readNapCatStickers({ httpUrl: "http://127.0.0.1:1234", accessToken: "" }, 48, (async () => {
    calls++; return Response.json({ status: "failed", retcode: 500, message: "failed" });
  }) as typeof fetch), /UPSTREAM_UNAVAILABLE/);
  assert.equal(calls, 1);
});
test("sticker sends retain the selected account ID and reject mixed media or other channels", () => {
  const request = { deliveryId: "sticker-send-test", sender: { agentType: "codex", sessionId: "test-session" },
    routeId: "test-route", channel: "napcat", params: { target: "private", userId: "1234", instanceId: "test-instance" },
    payload: { type: "sticker", stickerId: id, text: "收到" } };
  const normalized = prepareAgentSendRequest(request);
  assert.equal(normalized.internal.payloadType, "image");
  assert.deepEqual(normalized.internal.payload, request.payload);
  assert.throws(() => prepareAgentSendRequest({ ...request, payload: { ...request.payload, path: "/private.png" } }), /unsupported fields/);
  assert.throws(() => prepareAgentSendRequest({ ...request, payload: { type: "image", stickerId: id, url } }), /requires payload.type=sticker/);
  assert.throws(() => prepareAgentSendRequest({ ...request, payload: { type: "sticker", stickerId: "not-an-id" } }), /stickerId/);
});

test("group/private sticker sends preserve quotes, use native subtype and never send a removed favorite", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-sticker-send-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDir = path.join(rootDir, "data/route/route-test");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, "group-messages.jsonl"), JSON.stringify({ messageId: "5678", groupId: "1234", userId: "7890", adapterType: "napcat", rawMessage: "收到", message: [{ type: "text", data: { text: "收到" } }], instanceId: "account-test" }) + "\n");
  const sent: Array<{ action: string; body: Record<string, unknown> }> = [];
  let removed = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const action = request.url!;
      let data: unknown;
      if (action === "/fetch_custom_face_detail") data = removed ? [] : [{ md5: id, url, desc: "谢谢" }];
      else { sent.push({ action, body }); data = { message_id: sent.length }; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const opts: AgentReplyOptions = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"), runtimes: [{
    id: "route-test", enabled: true, pipeline: { outputAdapter: "qq", outputPipeline: "qq", replyToSource: true },
    napcatInstances: [{ id: "account-test", httpUrl: `http://127.0.0.1:${address.port}`, enabled: true, accessToken: "" }],
    messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["image"] } }
  }] };
  const request = { deliveryId: "sticker-send-group", sender: { agentType: "codex", sessionId: "test-session" },
    routeId: "route-test", channel: "napcat", params: { target: "group", groupId: "1234", replyToMessageId: "5678" },
    payload: { type: "sticker", stickerId: id, text: "收到" } };
  try {
    assert.equal((await handleAgentSend(request, opts)).status, "sent");
    assert.equal(sent[0]!.action, "/send_group_msg");
    const message = sent[0]!.body.message as Array<{ type: string; data: Record<string, unknown> }>;
    assert.deepEqual(message[0], { type: "reply", data: { id: "5678" } });
    assert.deepEqual(message.at(-1), { type: "image", data: { file: url, sub_type: 1, summary: "谢谢" } });
    assert.equal((await handleAgentSend({ ...request, deliveryId: "sticker-send-private", params: { target: "private", userId: "1234" } }, opts)).status, "sent");
    assert.equal(sent[1]!.action, "/send_private_msg");
    removed = true;
    assert.equal((await handleAgentSend({ ...request, deliveryId: "sticker-send-removed", params: { target: "private", userId: "1234" } }, opts)).status, "failed");
    assert.equal(sent.length, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("favorite parsing preserves long signed URLs and descriptions returned upstream", () => {
  const url = "https://cdn.example/image?signature=" + "x".repeat(5000);
  const description = "detail ".repeat(200);
  const [item] = parseNapCatStickers([{ url, md5: id, desc: description }]);
  assert.equal(item?.url, url); assert.equal(item?.description, description);
});
