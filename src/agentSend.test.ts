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
    deliveryId: "send-1",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group" },
    payload: { type: "text", text: "hello" }
  }), /params\.groupId/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-2",
    routeId: "route-main",
    params: {},
    payload: { type: "text", text: "hello" }
  }), /channel/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-legacy",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" },
    replyContext: { targetType: "group" }
  } as unknown as AgentSendRequest), /unsupported fields: replyContext/);
});

test("explicit NapCat send cannot be redirected to speech by the Route default pipeline", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let napcatBody: Record<string, unknown> = {};
  let napcatPath = "";
  await withJsonServer((body, request) => {
    napcatBody = body;
    napcatPath = request.url || "";
    return { status: "ok", retcode: 0, data: { message_id: 7788 } };
  }, async (url) => {
    const request: AgentSendRequest = {
      deliveryId: "send-napcat-1",
      routeId: "route-main",
      channel: "napcat",
      params: { target: "group", groupId: "456", instanceId: "qq-main", replyToMessageId: "123" },
      payload: { type: "text", text: "明确发到 QQ 群。" }
    };
    const result = await handleAgentSend(request, options(rootDir, url));

    assert.equal(result.status, "sent");
    assert.equal(result.channel, "napcat");
    assert.equal(result.groupId, "456");
    assert.equal(result.sentMessageId, "7788");
    assert.equal(napcatPath, "/send_group_msg");
    assert.equal(napcatBody.group_id, 456);
    assert.match(String(napcatBody.message), /CQ:reply,id=123/);
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
