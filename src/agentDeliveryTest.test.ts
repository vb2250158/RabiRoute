import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentDeliveryTestEnvelope,
  parseAgentDeliveryTestResult,
  serializeAgentDeliveryTestResult
} from "./agentDeliveryTest.js";

test("agent delivery test envelope carries a stable receipt marker", () => {
  const deliveryId = "12345678-1234-4234-8234-123456789abc";
  const envelope = buildAgentDeliveryTestEnvelope({
    deliveryId,
    gatewayId: "route-a",
    routeName: "Rabi",
    agentAdapterType: "codex"
  });

  assert.equal(envelope.messageSource.type, "system");
  assert.match(envelope.messageContent, /通道投递测试/);
  assert.match(envelope.messageContent, new RegExp(`deliveryId: ${deliveryId}`));
  assert.match(envelope.messageContent, /目标 Agent：codex/);
});

test("agent delivery test result round-trips through the child-process marker", () => {
  const result = {
    deliveryId: "12345678-1234-4234-8234-123456789abc",
    gatewayId: "route-a",
    agentAdapterType: "dsh" as const,
    status: "delivered" as const,
    completedAt: "2026-08-28T00:00:00.000Z"
  };
  assert.deepEqual(parseAgentDeliveryTestResult(`noise\n${serializeAgentDeliveryTestResult(result)}\n`), result);
  assert.equal(parseAgentDeliveryTestResult("missing marker"), null);
});
