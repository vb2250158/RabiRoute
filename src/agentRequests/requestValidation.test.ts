import test from "node:test";
import assert from "node:assert/strict";
import { agentThreadRequestFailureData } from "../agentThreads.js";
import { AgentThreadContractError, callerAgentDeliveryId, completeAgentSessionId, normalizeAgentThreadSourceType } from "./requestValidation.js";

test("opaque source and target validation identifies the repair field without guessing ID shapes", () => {
  assert.equal(completeAgentSessionId(`owner:${"x".repeat(700)}`, "sourceThreadId"), `owner:${"x".repeat(700)}`);
  for (const field of ["sourceThreadId", "threadId"] as const) {
    for (const value of [undefined, "", " padded ", 42, "line\nbreak", "nul\0id", "x".repeat(4097)]) {
      assert.throws(() => completeAgentSessionId(value, field), error => {
        assert.ok(error instanceof AgentThreadContractError);
        const data = agentThreadRequestFailureData(error, { action: "send" });
        const detail = data.error as Record<string, unknown>;
        assert.equal(detail.field, field);
        assert.equal(detail.stage, field === "sourceThreadId" ? "source_verification" : "validation");
        assert.equal(detail.retryable, false);
        assert.match(String(detail.repair), /complete existing/);
        return true;
      });
    }
  }
});

test("source role normalization shares the documented vocabulary and preserves the legacy optional default", () => {
  assert.equal(normalizeAgentThreadSourceType(undefined), "agent");
  assert.equal(normalizeAgentThreadSourceType(" plan_agent ", true), "plan_agent");
  for (const value of [undefined, "", "system", "constructor", "toString", 42]) {
    assert.throws(() => normalizeAgentThreadSourceType(value, true), { field: "sourceAgentType", stage: "source_verification" });
  }
  assert.equal(callerAgentDeliveryId(undefined), undefined);
  assert.equal(callerAgentDeliveryId("operation-1"), "operation-1");
  for (const value of [null, "", " padded", "bad\nkey", "x".repeat(101)]) assert.throws(() => callerAgentDeliveryId(value), { field: "deliveryId" });
});
