import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentRoleDeviceId, normalizeRemotePersonaReference, removePersonaOwnedGatewayConfig } from "./remotePersonaReference.js";

test("remote persona references retain the device and actual role identities", () => {
  assert.deepEqual(normalizeRemotePersonaReference({ agentRoleDeviceId: " pc-target ", agentRoleId: "Shared" }), { agentRoleDeviceId: "pc-target", agentRoleId: "Shared" });
  assert.deepEqual(normalizeRemotePersonaReference({ agentRoleDeviceId: "", agentRoleId: "Shared" }), { agentRoleDeviceId: undefined, agentRoleId: "Shared" });
  assert.equal(normalizeAgentRoleDeviceId(undefined), undefined);
});

test("malformed remote references cannot select or create a local fallback persona", () => {
  for (const deviceId of ["../pc", "http://pc", "pc name", "pc\nother", "x".repeat(129), 123]) {
    assert.throws(() => normalizeRemotePersonaReference({ agentRoleDeviceId: deviceId, agentRoleId: "Shared" }), /device ID/);
  }
  for (const roleId of [undefined, "", "../Shared", "Shared/child", " Shared ", "Shared\n", 123, ["Shared"]]) {
    assert.throws(() => normalizeRemotePersonaReference({ agentRoleDeviceId: "pc-target", agentRoleId: roleId }), /valid role ID/);
  }
});

test("discarding persona projections preserves Route ownership and the caller's input", () => {
  const input = { agentRoleId: "Shared", automationRules: ["old"], notificationRules: ["old"], recentMessageLimits: { heartbeat: 4 },
    languageStyle: "local", codexHooks: {}, speechTriggerKeywords: ["local"], roleNotificationRules: {}, roleRouteNames: {},
    speechPushMode: "keyword", routeVariables: { purpose: "example" }, personaAutomationScriptsEnabled: false };
  const result = removePersonaOwnedGatewayConfig(input);
  assert.deepEqual(result, { agentRoleId: "Shared", speechPushMode: "keyword", routeVariables: { purpose: "example" }, personaAutomationScriptsEnabled: false });
  assert.deepEqual(input.automationRules, ["old"]);
});
