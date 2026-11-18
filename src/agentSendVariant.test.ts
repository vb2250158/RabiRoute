import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { MessageEndpointEgressProvider, MessageEndpointSendVariant, MessageEndpointVariantSendInput } from "@rabiroute/plugin-sdk";
import type { AgentReplyOptions } from "./outbox.js";
import { handleAgentSend, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import { AGENT_SEND_WIRE_SCHEMA } from "./agentSendContracts.js";
import { AgentSendConversationContextGuard } from "./agentSendConversationContext.js";
import { agentSendVariantDescriptions, withAgentSendVariant } from "./agentSendVariant.js";
import { compilePluginDataSchema } from "./manager/apiOperationContract.js";
import { agentSendReceiptPath, executeIdempotentAgentSend, readAgentSendReceipt, replayAgentSendReceipt } from "./manager/agentSendIdempotency.js";
import { settleAgentSendDelivery, verifyAgentSendDelivery } from "./manager/agentSendReconciliation.js";

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
  const legacyPath = agentSendReceiptPath(rootDir, request.deliveryId as string);
  const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  delete legacy.audit.sendVariant.receiptMode;
  await fs.writeFile(legacyPath, JSON.stringify(legacy), "utf8");
  assert.equal((await verifyAgentSendDelivery(request.deliveryId, request, { rootDir,
    verify: async () => { throw new Error("A pre-existing historical receipt requires no current provider."); }
  })).body.originalResult?.sentMessageId, "original-native-id");
  const denied = await send({ ...request, deliveryId: "fixture-variant-blocked" }, false);
  assert.equal(denied.body.status, "blocked");
  assert.equal(calls.length, 1);
});

test("an ack-only send records its original acknowledgement without creating a message or visibility proof", async t => {
  const fixture = await acknowledgementFixture(t, () => ({ acknowledged: true }));
  const result = await fixture.send(fixture.request);
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.status, "acknowledged");
  assert.equal(result.body.receiptMode, "ack-only");
  assert.equal(Object.hasOwn(result.body, "sentMessageId"), false);
  assert.equal(agentSendVariantDescriptions(fixture.request.channel, fixture.provider)[0]?.receiptMode, "ack-only");
  assert.equal(readAgentSendReceipt(fixture.rootDir, fixture.request.deliveryId)?.state, "completed");
  assert.equal(replayAgentSendReceipt(fixture.rootDir, fixture.request)?.body.status, "acknowledged");
  const verification = { rootDir: fixture.rootDir, verify: async () => { throw new Error("An acknowledgement cannot prove platform visibility."); } };
  const verified = await verifyAgentSendDelivery(fixture.request.deliveryId, fixture.request, verification);
  assert.equal(verified.body.platformVerification, "unknown");
  assert.deepEqual(verified.body.evidence, { reason: "original_variant_acknowledgement", historicalTerminalProven: true, acknowledgementOnly: true });
  assert.equal((await settleAgentSendDelivery(fixture.request.deliveryId, fixture.request, verification)).body.state, "completed");
  assert.equal(fixture.calls.length, 1);
});

test("missing acknowledgement, zero IDs and mismatched result modes keep the original delivery uncertain", async t => {
  let returned: unknown;
  const fixture = await acknowledgementFixture(t, () => returned);
  const oldMessageVariant = { ...fixture.variant, receiptMode: undefined };
  const mismatches: Array<[unknown, MessageEndpointSendVariant]> = [
    [null, fixture.variant],
    [{ acknowledged: false }, fixture.variant],
    [{ acknowledged: true, messageId: 0 }, fixture.variant],
    [{ messageId: "signed-id" }, fixture.variant],
    [{ messageId: 0 }, oldMessageVariant],
    [{ messageId: "0" }, oldMessageVariant],
    [{ acknowledged: true }, oldMessageVariant]
  ];
  for (const [index, [outcome, variant]] of mismatches.entries()) {
    returned = outcome;
    const request = { ...fixture.request, deliveryId: `fixture-invalid-outcome-${index}` };
    const first = await fixture.send(request, {}, variant);
    assert.equal(first.body.idempotency.state, "uncertain");
    assert.equal(replayAgentSendReceipt(fixture.rootDir, request)?.body.idempotency.state, "uncertain");
    assert.equal((await fixture.send(request, {}, variant)).body.idempotency.state, "uncertain");
  }
  assert.equal(fixture.calls.length, mismatches.length);
});

test("variant output rules and host-owned attachment leases apply before native action", async t => {
  const fixture = await acknowledgementFixture(t, () => ({ acknowledged: true }));
  const fileId = "4c1d8d6a-1bd8-4869-89cd-213c9d745c73";
  const fileSha256 = "f".repeat(64);
  const variant: MessageEndpointSendVariant = { ...fixture.variant, allowEmptyText: true, readText: () => "",
    readMedia: () => ({ attachments: [{ kind: "file", fileId, fileSha256 }] }) };
  const withManagedGroupFile: NonNullable<AgentReplyOptions["withManagedGroupFile"]> = async (id, hash, send) => {
    assert.equal(id, fileId);
    assert.equal(hash, fileSha256);
    assert.equal(fixture.calls.length, 0);
    return send({ path: path.join(fixture.rootDir, "fixture.bin"), fileName: "fixture.bin" });
  };
  const blocked = await fixture.send(fixture.request, { withManagedGroupFile,
    runtimes: [{ id: "fixture-route", messageAdapters: ["napcat"], messageAdapterPolicies: { napcat: { supportedOutputs: ["text"] } } }] }, variant);
  assert.equal(blocked.body.status, "blocked");
  assert.equal(fixture.calls.length, 0);
  const permitted = await fixture.send({ ...fixture.request, deliveryId: "fixture-managed-file" }, { withManagedGroupFile,
    runtimes: [{ id: "fixture-route", messageAdapters: ["napcat"], messageAdapterPolicies: { napcat: { supportedOutputs: ["file"] } } }] }, variant);
  assert.equal(permitted.body.status, "acknowledged");
  assert.deepEqual(fixture.calls[0]?.attachments, [{ kind: "file", path: path.join(fixture.rootDir, "fixture.bin"), fileName: "fixture.bin" }]);
  assert.equal(fixture.calls[0]?.routeId, "fixture-route");
  assert.deepEqual(fixture.calls[0]?.target, { target: "group", groupId: "1", instanceId: "fixture-account" });
  const rawReference = { ...variant, readMedia: () => ({ attachments: [{ kind: "file", path: "fixture-private-path" }] }) } as unknown as MessageEndpointSendVariant;
  await assert.rejects(fixture.send({ ...fixture.request, deliveryId: "fixture-invalid-media" }, {}, rawReference), /invalid media kinds or managed attachment/);
  const deniedAfterRead = await fixture.send({ ...fixture.request, deliveryId: "fixture-attachment-revoked" }, {
    runtimes: [{ id: "fixture-route", messageAdapters: ["napcat"], messageAdapterPolicies: { napcat: { supportedOutputs: ["file"] } } }],
    withManagedGroupFile: (_id, _hash, send) => send({ path: "fixture.bin", fileName: "fixture.bin" }),
    assertVariantAuthority: () => { throw new Error("Original authority revoked during lease resolution."); }
  }, variant);
  assert.equal(deniedAfterRead.body.idempotency.state, "uncertain");
  assert.equal(fixture.calls.length, 1);
});

async function acknowledgementFixture(t: TestContext, outcome: () => unknown) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-send-ack-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const variant: MessageEndpointSendVariant = { type: "napcat.fixture-ack", description: "Test native acknowledgement",
    receiptMode: "ack-only", contractVersion: 1, operation: "fixtureAction",
    paramsSchema: { type: "object", additionalProperties: false, required: ["target", "groupId", "instanceId"], properties: {
      target: { const: "group" }, groupId: { type: "string" }, instanceId: { type: "string" } } },
    dataSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    readText: data => String(data.text) };
  const request = { deliveryId: "fixture-ack", sender: { agentType: "codex", sessionId: "fixture-task" }, routeId: "fixture-route",
    channel: "napcat", params: { target: "group", groupId: "1", instanceId: "fixture-account" },
    payload: { type: variant.type, data: { text: "Fixture action" } } } satisfies AgentSendRequest;
  const calls: MessageEndpointVariantSendInput[] = [];
  const provider: MessageEndpointEgressProvider = {
    identity: { pluginId: "io.test.ack", host: "manager", version: "1.0.0", revision: "b".repeat(64), instanceId: "endpoint:napcat",
      applicationGenerationId: "fixture", managerInstanceId: "fixture-manager", activationId: "fixture-ack-activation" },
    sendVariants: { [variant.type]: variant },
    inspect: () => ({ accepting: true, activeLeases: 0 }),
    runAcceptedWork: async operation => operation(),
    acquire(snapshot) {
      return { snapshot, async call<T>(operation: string, args: readonly unknown[]) {
        assert.equal(operation, variant.operation);
        calls.push(args[0] as MessageEndpointVariantSendInput);
        return outcome() as T;
      }, release() {} };
    }
  };
  const send = (body: AgentSendRequest, extra: Partial<AgentReplyOptions> = {}, shape = variant) =>
    withAgentSendVariant(body, { ...provider, sendVariants: { [shape.type]: shape } }, () =>
      executeIdempotentAgentSend(body, { rootDir, recover: async () => { throw new Error("Variant recovery must never replay."); },
        deliver: () => handleAgentSend(body, { rootDir, routeRoot: rootDir, rolesRoot: rootDir,
          runtimes: [{ id: "fixture-route", messageAdapters: ["napcat"] }], ...extra }) }));
  return { rootDir, variant, request, calls, provider, send };
}
