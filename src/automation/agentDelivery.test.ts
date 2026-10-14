import assert from "node:assert/strict";
import test from "node:test";
import { executeAgentDelivery, type AgentDeliveryHandlers } from "./agentDelivery.js";
import { defaultAgentRecipients, normalizeAgentDeliveryTarget } from "../shared/agentDeliveryTarget.js";
import { normalizePersonaAutomationRules, notificationRulesFromPersonaAutomations } from "../shared/gatewayConfigModel.js";

test("the selected recipient alone decides execution, including data-defined recipient IDs", async () => {
  const calls: string[] = [];
  const handlers: AgentDeliveryHandlers<void> = {
    primary: async () => { calls.push("primary"); }, plan_secretary: async () => { calls.push("secretary"); },
    message_pool: async () => { calls.push("pool"); }, memory_consolidation: async () => { calls.push("memory"); },
    session: async target => { calls.push(target.sessionId); }
  };
  await executeAgentDelivery({ kind: "recipient", recipientId: "my-secretary" },
    [{ id: "my-secretary", name: "Custom label", executor: "plan_secretary" }], handlers);
  assert.deepEqual(calls, ["secretary"]);
  await assert.rejects(executeAgentDelivery({ kind: "recipient", recipientId: "missing" }, [], handlers), /not configured/);
  assert.deepEqual(calls, ["secretary"]);
});

test("parallel custom targets retain their own identities and failure never falls back", async () => {
  const seen: string[] = [];
  const unexpected = async (): Promise<void> => { throw new Error("unexpected fallback"); };
  const handlers: AgentDeliveryHandlers<void> = { primary: unexpected, plan_secretary: unexpected, message_pool: unexpected,
    memory_consolidation: unexpected, session: async target => { await Promise.resolve(); seen.push(target.sessionId); if (target.sessionId === "offline") throw new Error("offline"); } };
  const target = (id: string) => normalizeAgentDeliveryTarget({ kind: "session", agentTargetId: "local:codex", agentAdapter: "codex", sessionId: id, sessionName: "Same name", workspace: "/workspace" });
  const results = await Promise.allSettled(["a", "b", "offline"].map(id => executeAgentDelivery(target(id), defaultAgentRecipients(), handlers)));
  assert.deepEqual(seen.sort(), ["a", "b", "offline"]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "rejected"]);
});

test("normalization and rule projection preserve the target and route scope", () => {
  const target = { kind: "recipient", recipientId: "message-processing" };
  const saved = normalizePersonaAutomationRules([{ id: "chat", sourceRouteIds: ["route-a"], trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", target } }]);
  const projected = notificationRulesFromPersonaAutomations(JSON.parse(JSON.stringify(saved)))[0];
  assert.deepEqual(projected.agentTarget, target);
  assert.deepEqual(projected.sourceRouteIds, ["route-a"]);
  assert.throws(() => normalizeAgentDeliveryTarget({ kind: "session" }), /complete/);
});
