import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCompletionRule, createTtsCompletionRule } from "../src/persona/agentCompletionRules";
import { agentHookRuleErrors, normalizeAgentCompletionDeliveries } from "../../src/shared/agentHookAutomation";

test("completion rule creation works with LAN HTTP crypto and starts disabled", () => {
  const lanCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  assert.equal("randomUUID" in lanCrypto, false);
  const first = createAgentCompletionRule(lanCrypto);
  const second = createAgentCompletionRule(lanCrypto);
  assert.match(first.id, /^completion-[a-f0-9]{32}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.enabled, false);
  assert.equal(first.destination.params.targetId, "");
  assert.deepEqual(first.conditions, []);
  assert.equal(first.event, "task_completed");
});

test("TTS shortcut creates a persona Hook rule with the current route and no QQ parameters", () => {
  const rule = createTtsCompletionRule("voice-route");
  assert.equal(rule.enabled, false);
  assert.equal(rule.event, "task_completed");
  assert.deepEqual(rule.destination, { channel: "speech", gatewayId: "voice-route", params: {} });
  assert.deepEqual(agentHookRuleErrors(rule), []);
  assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  assert.ok(agentHookRuleErrors(createTtsCompletionRule("")).length > 0);
});
