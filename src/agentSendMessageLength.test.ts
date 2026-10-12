import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentSendMessageLengthGuard } from "./agentSendMessageLength.js";
import { handleAgentSend, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";
import { executeIdempotentAgentSend, readAgentSendReceipt } from "./manager/agentSendIdempotency.js";

const request: AgentSendRequest = {
  deliveryId: "long-message-test", sender: { agentType: "codex", sessionId: "thread-test" },
  routeId: "route-main", channel: "napcat", params: { target: "group", groupId: "456", replyToMessageId: "" },
  payload: { type: "text", text: "查询仍然报错，请检查原因。" }
};
function options(threshold = 10): Pick<AgentReplyOptions, "runtimes"> {
  return { runtimes: [{ id: "gateway", routeProfiles: [{ id: "route-main" }], messageAdapterPolicies: { napcat: { textConfirmationThreshold: threshold } } }] };
}

test("over threshold returns a bound confirmation; equality and disabled checks allow text", () => {
  const guard = new AgentSendMessageLengthGuard();
  const result = guard.evaluate(request, options());
  assert.equal(result.blocked, true);
  assert.equal(result.metadata?.characterCount, 13);
  assert.ok(result.metadata?.confirmationToken);
  assert.equal(guard.evaluate(request, options(13)).blocked, false);
  assert.equal(guard.evaluate(request, options(0)).metadata, undefined);
  assert.equal(guard.evaluate(request, { runtimes: [{ id: "route-main" }] }).blocked, false);
  const confirmed = { ...request, messageLengthConfirmation: result.metadata?.confirmationToken };
  assert.equal(guard.evaluate(confirmed, options()).metadata?.confirmed, true);
  assert.equal(guard.evaluate({ ...confirmed, styleValidation: 0 }, options()).blocked, false);
});

test("text, target, sender, delivery ID, attachment and threshold changes require a new confirmation", () => {
  const guard = new AgentSendMessageLengthGuard();
  const token = guard.evaluate(request, options()).metadata?.confirmationToken;
  const confirmed = { ...request, messageLengthConfirmation: token };
  for (const patch of [
    { deliveryId: "another-send" }, { sender: { agentType: "codex", sessionId: "other-thread" } },
    { payload: { type: "text", text: "查询依然报错，请检查原因。" } },
    { params: { target: "group", groupId: "789", replyToMessageId: "" } },
    { payload: { type: "image", path: "/tmp/example.png", text: "查询仍然报错，请检查原因。" } }
  ]) assert.equal(guard.evaluate({ ...confirmed, ...patch }, options()).blocked, true);
  assert.equal(guard.evaluate(confirmed, options(11)).blocked, true);
  assert.throws(() => prepareAgentSendRequest({ ...request, messageLengthConfirmation: true }), /token/);
});

test("expired, forged and prior Manager tokens cannot confirm; returned token has a ten minute lifetime", () => {
  const now = 1_800_000_000_000;
  const guard = new AgentSendMessageLengthGuard();
  const result = guard.evaluate(request, options(), now);
  const confirmed = { ...request, messageLengthConfirmation: result.metadata?.confirmationToken };
  assert.equal(guard.evaluate(confirmed, options(), now + 600_000).blocked, true);
  assert.equal(new AgentSendMessageLengthGuard().evaluate(confirmed, options(), now).blocked, true);
  assert.equal(guard.evaluate({ ...request, messageLengthConfirmation: `${now + 1000}.${"0".repeat(64)}` }, options(), now).blocked, true);
});

test("count visible Unicode text and media captions, omit CQ control tags, preserve interior whitespace", () => {
  const guard = new AgentSendMessageLengthGuard();
  const single = guard.evaluate({ ...request, payload: { type: "text", text: "[CQ:at,qq=123]甲 😀乙。" } }, options(4));
  assert.equal(single.metadata?.characterCount, 5);
  assert.equal(single.blocked, true);
  const segments = guard.evaluate({ ...request, payload: { type: "image", segments: [
    { type: "text", text: "甲😀" }, { type: "image", path: "/tmp/example.png" }, { type: "markdown", text: "乙。" }
  ] } }, options(4));
  assert.equal(segments.metadata?.characterCount, 5);
  assert.equal(segments.blocked, true);
  assert.equal(guard.evaluate({ ...request, channel: "role_panel", params: { roleId: "Example" } }, options()).metadata, undefined);
});

test("warning creates no receipt, confirming delivers once, and later calls return the original receipt", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-length-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const guard = new AgentSendMessageLengthGuard();
  const privateRequest = { ...request, params: { target: "private", userId: "456" } };
  const warning = guard.evaluate(privateRequest, options());
  assert.equal(warning.blocked, true);
  assert.equal(readAgentSendReceipt(rootDir, String(request.deliveryId)), null);
  let sends = 0;
  const confirmed = { ...privateRequest, messageLengthConfirmation: warning.metadata?.confirmationToken };
  assert.equal(guard.evaluate(confirmed, options()).blocked, false);
  const deliver = async () => { sends++; return { ok: true, status: "sent" as const, sentMessageId: "example-message" }; };
  const first = await executeIdempotentAgentSend(confirmed, { rootDir, deliver });
  const second = await executeIdempotentAgentSend(privateRequest, { rootDir, deliver });
  assert.equal(first.body.idempotency.duplicate, false);
  assert.equal(second.body.idempotency.duplicate, true);
  assert.equal(sends, 1);
});

test("the second confirmed call reaches OneBot once; shortening is checked as a new body", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-length-http-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const sent: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/send_private_msg") sent.push(body.message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: req.url === "/get_login_info" ? { user_id: 10001 } : { message_id: 10002 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const opts: AgentReplyOptions = { rootDir, routeRoot: path.join(rootDir, "route"), rolesRoot: path.join(rootDir, "roles"),
    runtimes: [{ id: "route-main", enabled: true, napcatInstances: [{ id: "example", httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "", enabled: true }],
      messageAdapterPolicies: { napcat: { textConfirmationThreshold: 10, outputEnabled: true, supportedOutputs: ["text"] } } }] };
  const guard = new AgentSendMessageLengthGuard();
  const original = { ...request, params: { target: "private", userId: "456" } };
  const checkAndSend = async (input: AgentSendRequest) => {
    const check = guard.evaluate(input, opts);
    if (check.blocked) return { statusCode: 409, body: check.metadata };
    return executeIdempotentAgentSend(input, { rootDir, deliver: () => handleAgentSend(input, opts) });
  };
  const first = await checkAndSend(original);
  assert.equal(first.statusCode, 409);
  assert.equal(sent.length, 0);
  assert.equal(readAgentSendReceipt(rootDir, String(original.deliveryId)), null);
  const confirmation = (first.body as { confirmationToken: string }).confirmationToken;
  const shortened = { ...original, payload: { type: "text", text: "还是报错。" } };
  assert.equal(guard.evaluate(shortened, opts).blocked, false);
  const confirmed = { ...original, messageLengthConfirmation: confirmation };
  const second = await checkAndSend(confirmed);
  assert.equal(second.statusCode, 202);
  await executeIdempotentAgentSend(original, { rootDir, deliver: () => handleAgentSend(original, opts) });
  assert.deepEqual(sent, ["查询仍然报错，请检查原因。"]);
});
