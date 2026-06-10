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

test("repository upgrades legacy Codex agent adapters on read and write", () => {
  const rootDir = makeTempRoot();
  const configPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  writeJson(configPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["codexDesktop", "codexApp", "copilotCli"]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.deepEqual(config.gateways[0].agentAdapters, ["codex", "copilotCli"]);

  repo.writeConfig(config);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayDefinition;
  assert.deepEqual(saved.agentAdapters, ["codex", "copilotCli"]);
});

test("repository falls back invalid agent adapters to codex", () => {
  const rootDir = makeTempRoot();
  writeJson(path.join(rootDir, "data", "route", "main", "adapterConfig.json"), {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentAdapters: ["unknown"]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.deepEqual(config.gateways[0].agentAdapters, ["codex"]);
});

test("repository removes deleted route config files but preserves route history", () => {
  const rootDir = makeTempRoot();
  const keepConfigPath = path.join(rootDir, "data", "route", "keep", "adapterConfig.json");
  const removedConfigPath = path.join(rootDir, "data", "route", "removed", "adapterConfig.json");
  const removedHistoryPath = path.join(rootDir, "data", "route", "removed", "group-messages.jsonl");
  writeJson(keepConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8791 });
  writeJson(removedConfigPath, { enabled: true, messageAdapters: ["heartbeat"], gatewayPort: 8792 });
  fs.writeFileSync(removedHistoryPath, `${JSON.stringify({ message: "keep me" })}\n`, "utf8");

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.writeConfig({
    gateways: [{
      id: "keep",
      configName: "keep",
      enabled: true,
      messageAdapters: ["heartbeat"],
      gatewayPort: 8791,
      agentRoleId: "Rabi",
      notificationRules: []
    }]
  });

  assert.equal(fs.existsSync(keepConfigPath), true);
  assert.equal(fs.existsSync(removedConfigPath), false);
  assert.equal(fs.existsSync(removedHistoryPath), true);
});
