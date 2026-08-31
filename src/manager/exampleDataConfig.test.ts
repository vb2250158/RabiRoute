import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateGatewayPortConflicts } from "../shared/gatewayConfigModel.js";
import { ManagerConfigRepository } from "./configRepository.js";

test("the complete example data pack is readable and starts only the default route", t => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-example-data-"));
  fs.cpSync(path.join(projectRoot, "examples", "data"), path.join(rootDir, "data"), { recursive: true });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const repository = new ManagerConfigRepository({
    rootDir,
    managerPort: 8790,
    routeRoot: "data/route",
    rolesRoot: "data/roles",
  });
  const gateways = repository.readConfig().gateways;
  const byName = new Map(gateways.map((gateway) => [gateway.configName, gateway]));

  assert.equal(byName.get("main")?.enabled, true);
  for (const configName of ["RabiLink", "rokid-native-voice", "voice-chat", "wecom", "xiaoai"]) {
    assert.equal(byName.get(configName)?.enabled, false, `${configName} must remain opt-in`);
  }

  const rabiLink = byName.get("RabiLink");
  assert.equal(rabiLink?.agentRoleId, "RabiActive");
  assert.deepEqual(rabiLink?.messageAdapters, ["rolePanel", "rabilink", "wearable"]);
  assert.equal(rabiLink?.routeVariables?.rabilinkAutoReview, "true");
  assert.equal(rabiLink?.routeVariables?.rabilinkContinuousReflection, "true");
  assert.doesNotThrow(() => validateGatewayPortConflicts(gateways));
});
