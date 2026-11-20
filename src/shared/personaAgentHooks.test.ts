import assert from "node:assert/strict";
import test from "node:test";
import { agentHookSettingsFor, normalizeCodexHookSettings, type GatewayDefinition } from "./gatewayConfigModel.js";
import { agentAdapterTypes, agentAdapterSupportsLifecycleHooks } from "./agentAdapterCapabilities.js";
import { configuredPersonaHookAgents, editPersonaAgentRule, personaHookAgentOptions } from "./personaAgentHooks.js";

test("Hook choices come from configured local ends, excluding disabled routes and other owners", () => {
  const routes = [
    { id: "a", agentRoleId: "Example", agentAdapters: ["dsh", "codex", "copilotCli"] },
    { id: "b", agentRoleId: "Example", agentAdapters: ["dsh"] },
    { id: "c", agentRoleId: "Other", agentAdapters: ["workbuddy"] },
    { id: "d", agentRoleId: "Example", enabled: false, agentAdapters: ["antigravity"] },
    { id: "e", agentRoleId: "Example", agentRoleDeviceId: "remote", agentAdapters: ["workbuddy"] }
  ] as GatewayDefinition[];
  assert.deepEqual(configuredPersonaHookAgents(routes, "Example"), ["dsh", "codex"]);
  const supported = agentAdapterTypes.filter(agentAdapterSupportsLifecycleHooks);
  const preview = personaHookAgentOptions(routes.slice(1), "Example");
  assert.deepEqual(new Set(preview.map(item => item.value)), new Set(supported));
  assert.equal(preview[0].value, "dsh");
  assert.equal(preview[0].configured, true);
  assert.equal(preview.find(item => item.value === "codex")?.configured, false);
  assert.ok(personaHookAgentOptions([], "Example").every(item => !item.configured));
  assert.deepEqual(configuredPersonaHookAgents(routes, ""), []);
  assert.deepEqual(configuredPersonaHookAgents([{ id: "legacy", gatewayPort: 24001, agentRoleId: "Example" }], "Example"), ["codex"]);
  assert.deepEqual(configuredPersonaHookAgents([{ id: "empty", gatewayPort: 24002, agentRoleId: "Example", agentAdapters: [] }], "Example"), []);
});

test("per-Agent overrides round-trip independently and old persona settings stay the default", () => {
  const legacy = { sessionContextEnabled: false, planFollowup: { enabled: true, cooldownSeconds: 45, rules: [] } };
  const dsh = {
    sessionContextEnabled: true, reasoningContextEnabled: false,
    completionDeliveries: [{ id: "event", name: "  Completion notice  " }],
    planFollowup: { rules: [{ id: "followup", name: "  Check release  " }] }
  };
  const saved = normalizeCodexHookSettings({ ...legacy, byAgent: { dsh, unknown: dsh } });
  const loaded = normalizeCodexHookSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(saved, loaded);
  assert.equal(agentHookSettingsFor(loaded, "codex").sessionContextEnabled, false);
  assert.equal(agentHookSettingsFor(loaded, "codex").planFollowup?.enabled, true);
  assert.equal(agentHookSettingsFor(loaded, "dsh").sessionContextEnabled, true);
  assert.equal(agentHookSettingsFor(loaded, "dsh").reasoningContextEnabled, false);
  assert.equal(agentHookSettingsFor(loaded, "dsh").planFollowup?.enabled, false);
  assert.equal(loaded.byAgent?.dsh?.completionDeliveries?.[0]?.name, "Completion notice");
  assert.equal(loaded.byAgent?.dsh?.planFollowup?.rules[0]?.name, "Check release");
  assert.deepEqual(Object.keys(loaded.byAgent!), ["dsh"]);
});

test("moving a follow-up keeps unrelated target rules and preserves both Agents' settings", () => {
  const rule = { id: "same", enabled: true, statusKeys: ["active"], prompt: "Check the source" };
  const targetRule = { ...rule, prompt: "Check the destination" };
  const settings = normalizeCodexHookSettings({ byAgent: {
    dsh: { sessionContextEnabled: false, planFollowup: { enabled: true, cooldownSeconds: 60, rules: [rule] } },
    codex: { reasoningContextEnabled: false, planFollowup: { enabled: false, cooldownSeconds: 240, rules: [targetRule] } }
  } });
  const result = editPersonaAgentRule(settings, { targetAgent: "codex", sourceAgent: "dsh",
    rule: { kind: "followup", value: rule }, createId: () => "moved" });
  assert.equal(result.byAgent?.dsh?.sessionContextEnabled, false);
  assert.deepEqual(result.byAgent?.dsh?.planFollowup, { enabled: true, cooldownSeconds: 60, rules: [] });
  assert.equal(result.byAgent?.codex?.reasoningContextEnabled, false);
  assert.deepEqual(result.byAgent?.codex?.planFollowup, {
    enabled: false, cooldownSeconds: 240, rules: [targetRule, { ...rule, id: "moved" }]
  });
  assert.deepEqual(settings.byAgent?.dsh?.planFollowup?.rules, [rule]);
});
