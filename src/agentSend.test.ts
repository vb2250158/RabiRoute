import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentSend, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";

async function withJsonServer(
  handler: (body: Record<string, unknown>, request: http.IncomingMessage) => Record<string, unknown>,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(handler(body, request)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function options(rootDir: string, endpointUrl: string, speechServiceUrl?: string): AgentReplyOptions {
  return {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    speechServiceUrl,
    runtimes: [{
      id: "route-main",
      enabled: true,
      pipeline: { outputAdapter: "tts" },
      napcatInstances: [{ id: "qq-main", httpUrl: endpointUrl, accessToken: "", enabled: true }],
      messageAdapterPolicies: {
        napcat: { outputEnabled: true, supportedOutputs: ["text"] },
        speech: { outputEnabled: true, supportedOutputs: ["text"] }
      }
    }]
  };
}

test("strict send contract rejects missing explicit channel parameters", () => {
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-no-sender",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" }
  }), /sender/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-no-session",
    sender: { agentType: "codex" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" }
  }), /sender\.sessionId/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-1",
    sender: { agentType: "codex", sessionId: "thread-send-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group" },
    payload: { type: "text", text: "hello" }
  }), /params\.groupId/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-2",
    sender: { agentType: "codex", sessionId: "thread-send-2" },
    routeId: "route-main",
    params: {},
    payload: { type: "text", text: "hello" }
  }), /channel/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-legacy",
    sender: { agentType: "codex", sessionId: "thread-send-legacy" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" },
    replyContext: { targetType: "group" }
  } as unknown as AgentSendRequest), /unsupported fields: replyContext/);
});

test("NapCat group sends require an explicit reply choice", () => {
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "group-send-without-reply-choice",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "naked progress update" }
  }), /NapCat group sends must include params\.replyToMessageId.*use the source QQ message ID.*empty string.*intentional unquoted group message/i);

  assert.doesNotThrow(() => prepareAgentSendRequest({
    deliveryId: "group-send-with-empty-reply-choice",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "intentional unquoted group update" }
  }));

  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "message-processing-group-send-with-empty-reply-choice",
    sender: { agentType: "message_processing", sessionId: "message-processing-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "message processing must quote its source" }
  }), /message_processing.*non-empty params\.replyToMessageId/i);

  const intentionalFollowUp = prepareAgentSendRequest({
    deliveryId: "group-send-intentional-follow-up",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "123", allowAdditionalReply: true },
    payload: { type: "text", text: "new evidence after the first reply" }
  });
  assert.equal(intentionalFollowUp.allowAdditionalReply, true);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "group-send-invalid-follow-up-flag",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "123", allowAdditionalReply: "yes" },
    payload: { type: "text", text: "invalid follow-up flag" }
  }), /params\.allowAdditionalReply must be a boolean/i);
});

test("explicit NapCat send cannot be redirected to speech by the Route default pipeline", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDataDir = path.join(rootDir, "data", "route", "route-main");
  fs.mkdirSync(routeDataDir, { recursive: true });
  fs.writeFileSync(path.join(routeDataDir, "group-messages.jsonl"), `${JSON.stringify({
    messageId: "123",
    groupId: "456",
    userId: "789",
    botUserId: "999",
    adapterType: "napcat"
  })}\n`, "utf8");
  let napcatBody: Record<string, unknown> = {};
  let napcatPath = "";
  await withJsonServer((body, request) => {
    napcatBody = body;
    napcatPath = request.url || "";
    return { status: "ok", retcode: 0, data: { message_id: 7788 } };
  }, async (url) => {
    const request: AgentSendRequest = {
      deliveryId: "send-napcat-1",
      sender: { agentType: "codex", sessionId: "thread-napcat-1" },
      routeId: "route-main",
      channel: "napcat",
      params: { target: "group", groupId: "456", instanceId: "qq-main", replyToMessageId: "123" },
      payload: { type: "text", text: "明确发到 QQ 群。" }
    };
    const result = await handleAgentSend(request, options(rootDir, url));

    assert.equal(result.status, "sent");
    assert.equal(result.channel, "napcat");
    assert.deepEqual(result.sender, { agentType: "codex", sessionId: "thread-napcat-1" });
    assert.equal(result.groupId, "456");
    assert.equal(result.sentMessageId, "7788");
    assert.equal(napcatPath, "/send_group_msg");
    assert.equal(napcatBody.group_id, 456);
    assert.match(String(napcatBody.message), /CQ:reply,id=123/);
    assert.match(String(napcatBody.message), /CQ:at,qq=789/);
    const outboxRows = fs.readFileSync(
      path.join(rootDir, "data", "route", "route-main", "outbox-adapter.log.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    const requested = outboxRows.find(row => row.event === "send_requested");
    const loggedRequest = (requested?.data as Record<string, unknown> | undefined)?.request as Record<string, unknown> | undefined;
    assert.equal(loggedRequest?.senderAgentType, "codex");
    assert.equal(loggedRequest?.senderSessionId, "thread-napcat-1");
  });
});

test("a NapCat reply to an image message requires descriptions and archives them after sending", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-image-review-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDataDir = path.join(rootDir, "data", "route", "route-main");
  const mediaDir = path.join(routeDataDir, "napcat-media", "qq-main", "image-source-1");
  fs.mkdirSync(mediaDir, { recursive: true });
  const imagePath = path.join(mediaDir, "01-dynamic-background.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(routeDataDir, "group-messages.jsonl"), `${JSON.stringify({
    messageId: "image-source-1",
    groupId: "456",
    userId: "789",
    instanceId: "qq-main",
    adapterType: "napcat",
    rawMessage: "[CQ:image,file=dynamic-background.png]",
    attachments: [{
      id: "image-source-1:image:1",
      kind: "image",
      name: "dynamic-background.png",
      status: "ready",
      path: imagePath,
      sourceMessageId: "image-source-1"
    }]
  })}\n`, "utf8");
  let sends = 0;
  await withJsonServer(() => {
    sends += 1;
    return { status: "ok", retcode: 0, data: { message_id: 8899 } };
  }, async (url) => {
    const base: AgentSendRequest = {
      deliveryId: "send-image-review-1",
      sender: { agentType: "message_processing", sessionId: "thread-image-review-1" },
      routeId: "route-main",
      channel: "napcat",
      params: {
        target: "group",
        groupId: "456",
        instanceId: "qq-main",
        replyToMessageId: "image-source-1"
      },
      payload: { type: "text", text: "这个底框需要跟随动态文字宽度变化。" }
    };
    await assert.rejects(
      () => handleAgentSend(base, options(rootDir, url)),
      /params\.replyImageDescriptions must contain 1 descriptions/i
    );
    assert.equal(sends, 0);

    const result = await handleAgentSend({
      ...base,
      params: {
        ...(base.params as Record<string, unknown>),
        replyImageDescriptions: ["图片展示同一条动态文字变长后，灰色底框也随内容扩展，想表达背景需要自适应宽度。"]
      }
    }, options(rootDir, url));
    assert.equal(result.status, "sent");
    assert.equal(sends, 1);
    assert.equal(result.replyImageDescriptionArchive?.sourceMessageId, "image-source-1");
    assert.deepEqual(result.replyImageDescriptionArchive?.files.map((item) => item.descriptionFile), [
      "data/route/route-main/napcat-media/qq-main/image-source-1/01-dynamic-background.md"
    ]);
    const descriptionPath = path.join(mediaDir, "01-dynamic-background.md");
    assert.match(fs.readFileSync(descriptionPath, "utf8"), /背景需要自适应宽度/);
    assert.match(fs.readFileSync(descriptionPath, "utf8"), /8899/);
  });
});

test("speech is used only when the request explicitly selects the speech channel", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-speech-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let speechPath = "";
  await withJsonServer((_body, request) => {
    speechPath = request.url || "";
    return {};
  }, async (speechUrl) => {
    const result = await handleAgentSend({
      deliveryId: "send-speech-1",
      sender: { agentType: "codex", sessionId: "thread-speech-1" },
      routeId: "route-main",
      channel: "speech",
      params: { sessionId: "speech-session-1" },
      payload: { type: "text", text: "只进入语音合成。" }
    }, options(rootDir, "http://127.0.0.1:1", speechUrl));

    assert.equal(result.status, "sent");
    assert.equal(result.channel, "speech");
    assert.equal(result.targetType, "voice_transcript");
    assert.equal(speechPath, "/v1/audio/speech");
  });
});
