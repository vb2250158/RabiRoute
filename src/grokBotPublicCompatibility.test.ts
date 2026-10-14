import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentSend, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import { normalizeGatewayDefinition, primaryMessageProcessingAgentEnabled, type GatewayDefinition } from "./shared/gatewayConfigModel.js";
import { resolvePrimaryAgentTarget } from "./shared/routeAgentTargets.js";

const sessionId = (nativeSession: string | { defaultMain: true }) =>
  `grokBot:${Buffer.from(JSON.stringify(["example-bot-owner", nativeSession])).toString("base64url")}`;

test("Grok ordinary and default main Route identities survive normalization and persistence without Codex fallback", () => {
  for (const nativeSession of ["example-native-session", { defaultMain: true } as const]) {
    const grokFields = {
      grokBotProfilePath: "C:/example/grok-profile",
      grokBotBackendUrl: "https://example.test/grok-owner/",
      grokBotAgentId: "example-bot-owner",
      grokBotSessionId: sessionId(nativeSession),
      grokBotSessionName: "Existing cloud session"
    };
    const original: GatewayDefinition = {
      id: "grok-route", enabled: true, messageAdapters: ["napcat"], gatewayPort: 8789,
      napcatHttpUrl: "http://127.0.0.1:3000", agentAdapters: ["grokBot"],
      primaryAgentAdapter: "grokBot", ...grokFields,
      codexThreadId: "019f0000-0000-7000-8000-000000000015", codexThreadName: "Other Desktop task",
      codexCwd: "C:/example/workspace",
      messageProcessingAgents: { grokBot: { enabled: true, model: "example", reasoningEffort: "medium", maxAgents: 1 } },
      codexPlanAssistantEnabled: true, codexMemoryConsolidationAgentEnabled: true
    };
    const normalized = normalizeGatewayDefinition(original);
    const restored = normalizeGatewayDefinition(JSON.parse(JSON.stringify(normalized)));
    for (const [field, expected] of Object.entries(grokFields)) assert.equal(restored[field as keyof GatewayDefinition], expected);
    assert.deepEqual(resolvePrimaryAgentTarget(restored), { id: "local:grokBot", provider: "grokBot" });
    assert.equal(primaryMessageProcessingAgentEnabled(restored), false);
    assert.equal(restored.codexPlanAssistantEnabled, undefined);
    assert.equal(restored.codexMemoryConsolidationAgentEnabled, undefined);
    assert.equal(restored.grokBotSessionId, grokFields.grokBotSessionId);
    assert.notEqual(restored.grokBotSessionId, restored.codexThreadId);
  }
});

test("a Grok source can reply to the original QQ message through the standard send channel", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-grok-send-fixture-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const dataDir = path.join(rootDir, "data", "route", "grok-route");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "group-messages.jsonl"), `${JSON.stringify({
    messageId: "123", groupId: "456", userId: "789", botUserId: "999", adapterType: "napcat"
  })}\n`);
  let delivered = 0;
  let receivedPath = "";
  let receivedBody: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      delivered += 1;
      receivedPath = request.url || "";
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 7788 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request: AgentSendRequest = {
    deliveryId: "grok-qq-reply-fixture",
    sender: { agentType: "grokBot", sessionId: sessionId({ defaultMain: true }) },
    routeId: "grok-route", channel: "napcat",
    params: { target: "group", groupId: "456", instanceId: "example-qq-instance", replyToMessageId: "123" },
    payload: { type: "text", text: "Cloud Agent reply" }
  };
  const prepared = prepareAgentSendRequest(request);
  assert.equal(prepared.sender.agentType, "grokBot");
  assert.equal(prepared.sender.sessionId, sessionId({ defaultMain: true }));
  const result = await handleAgentSend(request, {
    rootDir, routeRoot: path.join(rootDir, "data", "route"), rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [{
      id: "grok-route", enabled: true,
      napcatInstances: [{ id: "example-qq-instance", httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "", enabled: true }],
      messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["text"] } }
    }]
  });
  assert.equal(delivered, 1);
  assert.equal(receivedPath, "/send_group_msg");
  assert.equal(receivedBody.group_id, 456);
  assert.match(String(receivedBody.message), /CQ:reply,id=123/);
  assert.match(String(receivedBody.message), /CQ:at,qq=789/);
  assert.equal(result.status, "sent");
  assert.equal(result.sentMessageId, "7788");
  assert.deepEqual(result.sender, request.sender);
});
