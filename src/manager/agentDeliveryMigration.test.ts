import assert from "node:assert/strict";
import test from "node:test";
import { migrateAgentDeliveryConfiguration } from "./agentDeliveryMigration.js";
import type { GatewayDefinition, PersonaAutomationRuleDefinition } from "../shared/gatewayConfigModel.js";
const route = (id: string, enabled: boolean): GatewayDefinition => ({ id, gatewayPort: 0, agentAdapters: ["codex"], primaryAgentAdapter: "codex", messageProcessingAgents: { codex: { enabled } } });
test("migration preserves bindings and separates two Routes sharing one persona", () => {
  const persona = { automationRules: [{ id: "chat", trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", template: "keep" } }], unrelated: { keep: true } };
  const routes = [route("a", true), { ...route("b", false), codexThreadId: "original-session" }];
  const result = migrateAgentDeliveryConfiguration(persona, routes);
  const rules = result.persona.automationRules as PersonaAutomationRuleDefinition[];
  const chat = rules.filter(item => item.id.startsWith("chat"));
  assert.equal(chat.length, 2);
  assert.deepEqual(chat.map(item => item.action.type === "deliver_agent" && item.action.target), [
    { kind: "recipient", recipientId: "message-processing" }, { kind: "recipient", recipientId: "primary" }
  ]);
  assert.deepEqual(chat.map(item => item.sourceRouteIds), [["a"], ["b"]]);
  assert.equal(result.routes[1].codexThreadId, "original-session");
  assert.deepEqual(result.persona.unrelated, { keep: true });
  assert.equal(migrateAgentDeliveryConfiguration(result.persona, result.routes).changed, false);
  assert.equal((persona.automationRules[0].action as Record<string, unknown>).target, undefined);
});
test("migration retains explicit targets and disabled rules", () => {
  const result = migrateAgentDeliveryConfiguration({ automationRules: [{ id: "chat", enabled: false, trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" } } }] }, [route("a", true)]);
  const rule = (result.persona.automationRules as PersonaAutomationRuleDefinition[])[0];
  assert.equal(rule.enabled, false);
  assert.deepEqual(rule.action.type === "deliver_agent" && rule.action.target, { kind: "recipient", recipientId: "primary" });
});
