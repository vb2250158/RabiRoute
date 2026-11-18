import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessageEndpointEgressProvider, MessageEndpointSendVariant, MessageEndpointVariantSendInput } from "@rabiroute/plugin-sdk";
import { handleAgentSend, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import { AGENT_SEND_WIRE_SCHEMA } from "./agentSendContracts.js";
import { AgentSendConversationContextGuard } from "./agentSendConversationContext.js";
import { agentSendVariantDescriptions, withAgentSendVariant } from "./agentSendVariant.js";
import { compilePluginDataSchema } from "./manager/apiOperationContract.js";
import { executeIdempotentAgentSend, readAgentSendReceipt, replayAgentSendReceipt } from "./manager/agentSendIdempotency.js";
import { verifyAgentSendDelivery } from "./manager/agentSendReconciliation.js";

test("a registered channel uses the original send policy, owner lease and receipt without a host enum", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-send-variant-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const channel = "fixture-chat";
  const variant: MessageEndpointSendVariant = { type: `${channel}.greeting`, description: "Fixture", contractVersion: 1,
    paramsSchema: { type: "object", additionalProperties: false, required: ["room"], properties: { room: { type: "string" } } },
    dataSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", pattern: "\\S" } } },
    readText: data => String(data.text), operation: "sendGreeting" };
  const request: AgentSendRequest = { deliveryId: "fixture-variant-original", sender: { agentType: "codex", sessionId: "fixture-task" },
    routeId: "fixture-route", channel, params: { room: "fixture-room" }, payload: { type: variant.type, data: { text: "Fixture greeting" } } };
  const validateWire = compilePluginDataSchema(AGENT_SEND_WIRE_SCHEMA);
  assert.equal(validateWire(request), true, JSON.stringify(validateWire.errors));
  assert.equal(validateWire({ ...request, payload: { type: "text", text: "Unsupported legacy channel" } }), false);
  assert.throws(() => prepareAgentSendRequest(request), /Unsupported send channel|published provider/);
  const calls: Array<{ operation: string; input: MessageEndpointVariantSendInput }> = [];
  let activeLeases = 0;
  const provider: MessageEndpointEgressProvider = {
    identity: { pluginId: "io.test.fixture-chat", host: "manager", version: "1.0.0", revision: "a".repeat(64), instanceId: `endpoint:${channel}`,
      applicationGenerationId: "fixture", managerInstanceId: "fixture-manager", activationId: "fixture-activated" },
    sendVariants: { [variant.type]: variant },
    inspect: () => ({ accepting: true, activeLeases }),
    runAcceptedWork: async operation => operation(),
    acquire(snapshot) {
      activeLeases++;
      return { snapshot, async call<T>(operation: string, args: readonly unknown[]) {
        calls.push({ operation, input: args[0] as MessageEndpointVariantSendInput });
        return { messageId: "original-native-id" } as T;
      }, release() { activeLeases--; } };
    }
  };
  assert.equal(agentSendVariantDescriptions(channel, provider)[0]?.type, variant.type);
  await assert.rejects(withAgentSendVariant({ ...request, params: { wrong: "x" } }, provider, async () => {}), /Invalid target parameters/);
  await assert.rejects(withAgentSendVariant({ ...request, payload: { type: variant.type, data: { text: "" } } }, provider, async () => {}), /Invalid data/);
  const runtimes = [{ id: "fixture-route", messageAdapters: [channel] }];
  const review = new AgentSendConversationContextGuard(async () => { throw new Error("The guard must stop before reading a channel-wide window."); });
  await assert.rejects(withAgentSendVariant(request, provider, () => review.evaluate(request, { rootDir, routeRoot: rootDir, rolesRoot: rootDir,
    runtimes: [{ ...runtimes[0]!, messageAdapterPolicies: { [channel]: { conversationReview: { enabled: true } } } }] })),
  /Conversation review requires an exact supported conversation target/);
  const send = (value: AgentSendRequest, allowed = true) => withAgentSendVariant(value, provider, async () => {
    assert.equal(activeLeases, 1);
    return executeIdempotentAgentSend(value, { rootDir, deliver: () => handleAgentSend(value, { rootDir, routeRoot: rootDir, rolesRoot: rootDir,
      runtimes: allowed ? runtimes : [{ ...runtimes[0]!, messageAdapterPolicies: { [channel]: { outputEnabled: false } } }] }) });
  });
  const sent = await send(request);
  assert.equal(sent.body.sentMessageId, "original-native-id");
  assert.equal(sent.body.channel, channel);
  assert.equal(activeLeases, 0);
  assert.deepEqual(calls.map(({ operation, input }) => ({ operation, target: input.target, data: input.data })),
    [{ operation: "sendGreeting", target: { room: "fixture-room" }, data: { text: "Fixture greeting" } }]);
  const audit = readAgentSendReceipt(rootDir, "fixture-variant-original")?.audit as { sendVariant: { activationId: string } };
  assert.equal(audit.sendVariant.activationId, "fixture-activated");
  assert.equal(replayAgentSendReceipt(rootDir, request)?.body.idempotency.duplicate, true);
  assert.equal(replayAgentSendReceipt(rootDir, { ...request, params: { room: "other-room" } })?.body.idempotency.state, "conflict");
  const verify = await verifyAgentSendDelivery(request.deliveryId, request, { rootDir,
    verify: async () => { throw new Error("The original stored variant receipt is sufficient for historical verification."); } });
  assert.equal(verify.body.originalResult?.sentMessageId, "original-native-id");
  assert.equal(verify.body.platformVerification, "unknown");
  const denied = await send({ ...request, deliveryId: "fixture-variant-blocked" }, false);
  assert.equal(denied.body.status, "blocked");
  assert.equal(calls.length, 1);
});
