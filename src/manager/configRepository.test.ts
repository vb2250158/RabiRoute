import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ManagerConfigRepository } from "./configRepository.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-repo-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("repository reads route config and falls back to personaConfig rules", () => {
  const rootDir = makeTempRoot();
  writeJson(path.join(rootDir, "data", "route", "main", "adapterConfig.json"), {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi"
  });
  writeJson(path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json"), {
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "tick\\ntock" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways.length, 1);
  assert.equal(config.gateways[0].id, "main");
  assert.equal(config.gateways[0].agentRoleId, "Rabi");
  assert.equal(config.gateways[0].notificationRules?.[0]?.template, "tick\ntock");
});

test("repository writes normalized configs and removes renamed route files", () => {
  const rootDir = makeTempRoot();
  const oldConfigPath = path.join(rootDir, "data", "route", "old", "adapterConfig.json");
  writeJson(oldConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8789 });
  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const next: GatewayDefinition = {
    id: "old",
    configName: "new",
    enabled: true,
    messageAdapters: ["webhook"],
    gatewayPort: 8790,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "hello" }]
  };

  const written = repo.writeConfig({ gateways: [next] });
  const newConfigPath = path.join(rootDir, "data", "route", "new", "adapterConfig.json");

  assert.equal(written.gateways[0].configName, "new");
  assert.equal(written.gateways[0].webhookPort, 8791);
  assert.equal(fs.existsSync(oldConfigPath), false);
  assert.equal(fs.existsSync(newConfigPath), true);
});
