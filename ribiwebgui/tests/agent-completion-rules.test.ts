import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCompletionRule, createTtsCompletionRule } from "../../src/plugins/io.rabiroute.manager.persona/web/persona/agentCompletionRules";
import { agentHookRuleErrors, normalizeAgentCompletionDeliveries } from "../../src/shared/agentHookAutomation";

test("completion rule creation works with LAN HTTP crypto and starts disabled", () => {
  const lanCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  assert.equal("randomUUID" in lanCrypto, false);
  const first = createAgentCompletionRule(lanCrypto);
  const second = createAgentCompletionRule(lanCrypto);
  assert.match(first.id, /^completion-[a-f0-9]{32}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.enabled, false);
  assert.equal(first.destination.params.includeFiles, "true");
  assert.equal(first.destination.params.markdownFilesAsImages, "true");
  assert.equal(first.destination.params.imageFilesAsImages, "true");
  assert.equal(first.destination.params.htmlFilesAsLinks, "true");
  assert.equal(first.destination.params.renderDiagrams, "true");
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

test("attachment conversion preferences retain legacy defaults, explicit opt-outs and unrelated rule identity", () => {
  const original = createAgentCompletionRule();
  original.enabled = true;
  original.destination.gatewayId = "original-route";
  original.destination.params.targetId = "123456";
  original.destination.params.instanceId = "original-account";
  const keys = ["markdownFilesAsImages", "imageFilesAsImages", "htmlFilesAsLinks"] as const;
  for (const key of keys) delete original.destination.params[key];
  const [legacy] = normalizeAgentCompletionDeliveries([original]);
  assert.equal(legacy.id, original.id);
  for (const key of keys) assert.equal(legacy.destination.params[key], undefined);
  for (const value of [false, "false", true, "true"]) {
    const params = { ...legacy.destination.params, includeFiles: false,
      markdownFilesAsImages: value, imageFilesAsImages: value, htmlFilesAsLinks: value };
    const [normalized] = normalizeAgentCompletionDeliveries([{ ...legacy, destination: { ...legacy.destination, params } }]);
    assert.equal(normalized.destination.params.includeFiles, "false");
    for (const key of keys) assert.equal(normalized.destination.params[key], String(value));
    assert.deepEqual(normalized.conditions, original.conditions);
    assert.equal(normalized.id, original.id); assert.equal(normalized.enabled, true);
    assert.equal(normalized.destination.gatewayId, "original-route");
    assert.equal(normalized.destination.params.targetId, "123456");
    assert.deepEqual(normalizeAgentCompletionDeliveries([normalized]), [normalized]);
  }
});
