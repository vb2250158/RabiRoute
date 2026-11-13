import assert from "node:assert/strict";
import test from "node:test";
import { executeAgentDelivery, type AgentDeliveryHandlers } from "./agentDelivery.js";
import { defaultAgentRecipients, normalizeAgentDeliveryTarget, validateAgentDeliveryTarget } from "../shared/agentDeliveryTarget.js";
import { normalizePersonaAutomationRules, notificationRulesFromPersonaAutomations } from "../shared/gatewayConfigModel.js";
import { personaAutomationRulesFromNotificationRules } from "../shared/gatewayConfigModel.js";

test("automation history counts survive saving, legacy conversion and notification projection", () => {
  for (const [input, expected] of [[0, 0], [3, 3], [250, 200], [-1, 0], [2.9, 2]] as const) {
    const saved = normalizePersonaAutomationRules([{ id: "chat", trigger: { type: "message", routeKinds: ["private"] },
      action: { type: "deliver_agent", recentMessageLimit: input } }]);
    const reloaded = normalizePersonaAutomationRules(JSON.parse(JSON.stringify(saved)));
    const projected = notificationRulesFromPersonaAutomations(reloaded);
    assert.equal(projected[0].recentMessageLimit, expected);
    const migrated = personaAutomationRulesFromNotificationRules(projected)[0];
    assert.equal(migrated.action.type === "deliver_agent" && migrated.action.recentMessageLimit, expected);
  }
  const legacy = normalizePersonaAutomationRules([{ id: "old", trigger: { type: "message" }, action: { type: "deliver_agent" } }]);
  assert.equal(notificationRulesFromPersonaAutomations(legacy)[0].recentMessageLimit, undefined);
});

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

test("Grok delivery choices round-trip and reject incomplete or stale sender identities", () => {
  const group = { kind: "session", agentAdapter: "grokBot", agentTargetId: "local:grokBot", sessionId: "group-address",
    sessionName: "Example group", workspace: "", deliveryType: "group", sendMode: "identity",
    senderAgentId: "example-bot", senderAgentName: "Example" };
  const target = normalizeAgentDeliveryTarget(group);
  assert.deepEqual(target, group);
  validateAgentDeliveryTarget(target);
  const rules = normalizePersonaAutomationRules([{ id: "group-bridge", trigger: { type: "message", routeKinds: ["group_message"] }, action: { type: "deliver_agent", target } }]);
  assert.deepEqual(notificationRulesFromPersonaAutomations(rules)[0].agentTarget, target);
  assert.throws(() => validateAgentDeliveryTarget(normalizeAgentDeliveryTarget({ ...group, senderAgentId: "" })), /sender identity/);
  assert.throws(() => normalizeAgentDeliveryTarget({ ...group, sendMode: "direct" }), /retain a sender/);
  assert.throws(() => normalizeAgentDeliveryTarget({ ...group, agentAdapter: "codex" }), /Invalid Grok/);
});

test("DSBot targets preserve exact scope and never default to primary or a Session", async () => {
  const target = normalizeAgentDeliveryTarget({ kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "scope", botId: "bot", botName: "Bot", dshBaseUrl: "http://127.0.0.1:1234" });
  const unexpected = async () => { throw new Error("fallback forbidden"); };
  const result = await executeAgentDelivery(target, [], { primary: unexpected, plan_secretary: unexpected, message_pool: unexpected, memory_consolidation: unexpected, session: unexpected, ds_bot: async value => value.botId });
  assert.equal(result, "bot");
  assert.throws(() => normalizeAgentDeliveryTarget({ ...target, agentAdapter: "codex" }), /exact DSH/);
  assert.throws(() => normalizeAgentDeliveryTarget({ ...target, botScopeId: "" }), /exact DSH/);
});

test("DSBot owner references round-trip without primary or Route and reject mixed or missing owners", () => {
  const local = { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "scope", botId: "bot", botName: "Bot", dshBaseUrl: "http://127.0.0.1:1234" };
  const remote = { ...local, agentTargetId: "peer:device:instance:dsh", dshBaseUrl: undefined, instanceBinding: { ownerDeviceId: "device", instanceId: "instance", agentId: "dsh" } };
  assert.deepEqual(normalizeAgentDeliveryTarget(JSON.parse(JSON.stringify(local))), local);
  assert.deepEqual(normalizeAgentDeliveryTarget(JSON.parse(JSON.stringify(remote))), { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: remote.agentTargetId, botScopeId: "scope", botId: "bot", botName: "Bot", instanceBinding: remote.instanceBinding });
  for (const invalid of [{ ...local, dshBaseUrl: undefined }, { ...local, instanceBinding: remote.instanceBinding }, { ...remote, dshBaseUrl: local.dshBaseUrl }, { ...remote, instanceBinding: undefined }, { ...remote, agentTargetId: "peer:another:instance:dsh" }, { ...local, dshBaseUrl: "http://127.0.0.1:1234/?token=private" }]) assert.throws(() => normalizeAgentDeliveryTarget(invalid));
});
