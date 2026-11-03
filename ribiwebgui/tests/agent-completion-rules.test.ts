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
  assert.equal(first.destination.params.renderTables, "true");
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

test("table rendering opt out persists and old rules retain their original fields", () => {
  const original = createAgentCompletionRule();
  delete original.destination.params.renderTables;
  const [old] = normalizeAgentCompletionDeliveries([original]);
  assert.equal(old.destination.params.renderTables, undefined);
  for (const renderTables of ["false", "true"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ ...old, destination: { ...old.destination, params: { ...old.destination.params, renderTables } } }]);
    assert.equal(rule.destination.params.renderTables, renderTables);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
});
