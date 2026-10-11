import test from "node:test";
import assert from "node:assert/strict";
import { deviceAgentInstanceFromCatalog } from "../src/deviceAgentCatalog";
import { addRouteAgent } from "../src/routeAgentTargetEditor";
import { normalizeGatewayDefinition } from "../../src/shared/gatewayConfigModel";

test("device catalog retains device owner PC and stable device identity through route save", () => {
  const instance = deviceAgentInstanceFromCatalog({ ownerInstanceId: "pc-owner-guid", agents: [{ agentId: "device:stable", name: "Glasses", provider: "deviceAgent", enabled: true }] })!;
  assert.equal(instance.instanceId, "pc-owner-guid");
  assert.equal(instance.local, true);
  assert.equal(instance.agents[0].provider, "deviceAgent");
  const draft = normalizeGatewayDefinition({ id: "example", gatewayPort: 8801, agentAdapters: [] });
  addRouteAgent(draft, "deviceAgent", instance.instanceId, instance.agents[0].agentId);
  const saved = normalizeGatewayDefinition(draft);
  assert.equal(saved.remoteAgentTargets?.[0].instanceId, "pc-owner-guid");
  assert.equal(saved.remoteAgentTargets?.[0].agentId, "device:stable");
  assert.equal(saved.remoteAgentTargets?.[0].provider, "deviceAgent");
});

test("catalog never guesses a Codex identity, invents a missing owner or accepts duplicate devices", () => {
  assert.equal(deviceAgentInstanceFromCatalog({ ownerInstanceId: "pc-owner-guid", agents: [] }), undefined);
  assert.throws(() => deviceAgentInstanceFromCatalog({ agents: [] }), /设备 Agent 未配置/);
  assert.throws(() => deviceAgentInstanceFromCatalog({ ownerInstanceId: "pc-owner-guid", agents: [{ agentId: "device", provider: "codex" }] }), /不匹配/);
  assert.throws(() => deviceAgentInstanceFromCatalog({ ownerInstanceId: "pc-owner-guid", agents: [{ agentId: "device", provider: "deviceAgent" }, { agentId: "device", provider: "deviceAgent" }] }), /Duplicate/);
});
