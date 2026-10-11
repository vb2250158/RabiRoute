import test from "node:test";
import assert from "node:assert/strict";
import { agentAdapterManifest, agentAdapterSupportsManagedTaskFeature, isAgentThreadCapableAdapter, isPlanAssistantAgentType, normalizePlanBindingAgentType } from "./agentAdapterCapabilities.js";
import { normalizeAgentInstanceBindings } from "./agentInstance.js";
import { parseAgentAdapterType } from "../agentAdapters/types.js";

test("device Agent declares only implemented experimental thread capability", () => {
  assert.equal(parseAgentAdapterType("deviceAgent"), "deviceAgent");
  assert.equal(agentAdapterManifest("deviceAgent").maturity, "experimental");
  assert.equal(agentAdapterSupportsManagedTaskFeature("deviceAgent", "messageProcessingAgent"), false);
  assert.equal(isAgentThreadCapableAdapter("deviceAgent"), true);
  for (const feature of ["planAssistantSessions", "memoryConsolidationAgent", "hooks", "deliveryReceiptRecovery"] as const) {
    assert.equal(agentAdapterSupportsManagedTaskFeature("deviceAgent", feature), false);
  }
  assert.equal(isPlanAssistantAgentType("deviceAgent"), false);
  assert.throws(() => normalizePlanBindingAgentType("deviceAgent"), /Unsupported/);
  assert.deepEqual(normalizeAgentInstanceBindings({ deviceAgent: { instanceId: "pc-owner", agentId: "device-stable" } }), { deviceAgent: { instanceId: "pc-owner", agentId: "device-stable" } });
});
