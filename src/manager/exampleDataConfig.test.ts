import assert from "node:assert/strict";
import test from "node:test";
import { validateGatewayPortConflicts } from "../shared/gatewayConfigModel.js";
import { ManagerConfigRepository } from "./configRepository.js";

test("the complete example data pack is readable and starts only the default route", () => {
  const repository = new ManagerConfigRepository({
    rootDir: process.cwd(),
    managerPort: 8790,
    routeRoot: "examples/data/route",
    rolesRoot: "examples/data/roles",
  });
  const gateways = repository.readConfig().gateways;
  const byName = new Map(gateways.map((gateway) => [gateway.configName, gateway]));

  assert.equal(byName.get("main")?.enabled, true);
  for (const configName of ["RabiLink", "rokid-native-voice", "voice-chat", "wecom", "xiaoai"]) {
    assert.equal(byName.get(configName)?.enabled, false, `${configName} must remain opt-in`);
  }

  const rabiLink = byName.get("RabiLink");
  assert.equal(rabiLink?.agentRoleId, "RabiActive");
  assert.deepEqual(rabiLink?.messageAdapters, ["rolePanel", "rabilink"]);
  assert.equal(rabiLink?.routeVariables?.rabilinkAutoReview, "true");
  assert.equal(rabiLink?.routeVariables?.rabilinkContinuousReflection, "true");
  assert.doesNotThrow(() => validateGatewayPortConflicts(gateways));
});
