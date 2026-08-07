import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommunicationToolDenial,
  isPersistentCodexTaskDeliveryTool
} from "./agentCommunicationHookPolicy.js";

test("Rabi managed tasks are denied when they bypass the Agent thread bridge", () => {
  assert.equal(isPersistentCodexTaskDeliveryTool("send_message_to_thread"), true);
  assert.equal(isPersistentCodexTaskDeliveryTool("codex.send_message_to_thread"), true);
  assert.equal(isPersistentCodexTaskDeliveryTool("send_message"), false);
  const denial = agentCommunicationToolDenial({
    sessionId: "session-1",
    eventName: "PreToolUse",
    toolName: "handoff_thread",
    toolInput: { threadId: "target" }
  }, true);
  assert.equal(denial?.permissionDecision, "deny");
  assert.match(denial?.reason || "", /responsePolicy/);
  assert.match(denial?.reason || "", /inReplyToRequestId/);
});

test("unmanaged tasks and non-persistent subagent tools are not blocked", () => {
  assert.equal(agentCommunicationToolDenial({
    sessionId: "session-1",
    eventName: "PreToolUse",
    toolName: "send_message_to_thread"
  }, false), undefined);
  assert.equal(agentCommunicationToolDenial({
    sessionId: "session-1",
    eventName: "PreToolUse",
    toolName: "send_message"
  }, true), undefined);
});
