import assert from "node:assert/strict";
import test from "node:test";
import { agentHookSettingsFor, normalizeCodexHookSettings, type GatewayDefinition } from "./gatewayConfigModel.js";
import { configuredPersonaHookAgents } from "./personaAgentHooks.js";

test("Hook choices come from configured local ends, excluding disabled routes and other owners", () => {
  const routes = [
    { id: "a", agentRoleId: "Example", agentAdapters: ["dsh", "codex", "copilotCli"] },
    { id: "b", agentRoleId: "Example", agentAdapters: ["dsh"] },
    { id: "c", agentRoleId: "Other", agentAdapters: ["workbuddy"] },
    { id: "d", agentRoleId: "Example", enabled: false, agentAdapters: ["antigravity"] },
    { id: "e", agentRoleId: "Example", agentRoleDeviceId: "remote", agentAdapters: ["workbuddy"] }
  ] as GatewayDefinition[];
  assert.deepEqual(configuredPersonaHookAgents(routes, "Example"), ["dsh", "codex"]);
  assert.deepEqual(configuredPersonaHookAgents(routes, ""), []);
  assert.deepEqual(configuredPersonaHookAgents([{ id: "legacy", gatewayPort: 24001, agentRoleId: "Example" }], "Example"), ["codex"]);
  assert.deepEqual(configuredPersonaHookAgents([{ id: "empty", gatewayPort: 24002, agentRoleId: "Example", agentAdapters: [] }], "Example"), []);
});

test("per-Agent overrides round-trip independently and old persona settings stay the default", () => {
  const legacy = { sessionContextEnabled: false, planFollowup: { enabled: true, cooldownSeconds: 45, rules: [] } };
  const dsh = { sessionContextEnabled: true, reasoningContextEnabled: false, completionDeliveries: [] };
  const saved = normalizeCodexHookSettings({ ...legacy, byAgent: { dsh, unknown: dsh } });
  const loaded = normalizeCodexHookSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(saved, loaded);
  assert.equal(agentHookSettingsFor(loaded, "codex").sessionContextEnabled, false);
  assert.equal(agentHookSettingsFor(loaded, "codex").planFollowup?.enabled, true);
  assert.equal(agentHookSettingsFor(loaded, "dsh").sessionContextEnabled, true);
  assert.equal(agentHookSettingsFor(loaded, "dsh").reasoningContextEnabled, false);
  assert.equal(agentHookSettingsFor(loaded, "dsh").planFollowup?.enabled, false);
  assert.deepEqual(Object.keys(loaded.byAgent!), ["dsh"]);
});
