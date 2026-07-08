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

test("repository reads and writes persona recent message limit", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi"
  });
  writeJson(personaPath, {
    recentMessageLimit: 3,
    notificationRules: [{ id: "heartbeat", routeKinds: ["heartbeat"], template: "tick" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(config.gateways[0].recentMessageLimit, 3);
  assert.equal(config.gateways[0].routeProfiles?.[0]?.recentMessageLimit, 3);

  config.gateways[0].recentMessageLimit = 2;
  repo.writeConfig(config);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as GatewayDefinition;
  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition;
  assert.equal(adapter.recentMessageLimit, undefined);
  assert.equal(persona.recentMessageLimit, 2);
});

test("repository migrates legacy role rules to personaConfig and keeps adapter config clean", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "config-1", "adapterConfig.json");
  const legacyPath = path.join(rootDir, "data", "roles", "Rabi", "roleMessageConfig.json");
  const routesPath = path.join(rootDir, "data", "roles", "Rabi", "routes.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["rolePanel"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "legacy-adapter", routeKinds: ["private"], template: "" }],
    roleNotificationRules: {
      "Rabi__config-1": [{ id: "legacy-role-map", routeKinds: ["group_message"], template: "" }]
    },
    roleRouteNames: {
      "Rabi__config-1": "Old Route"
    },
    routeProfiles: [{
      id: "profile-rabi",
      agentRoleId: "Rabi",
      notificationRules: [{ id: "legacy-profile", routeKinds: ["heartbeat"], template: "" }]
    }, {
      id: "profile-momo",
      agentRoleId: "Momo",
      notificationRules: [{ id: "momo-profile", routeKinds: ["private"], template: "" }]
    }]
  });
  writeJson(legacyPath, {
    configs: [{
      configName: "main",
      notificationRules: [{ id: "legacy-role", routeKinds: ["heartbeat"], template: "" }]
    }]
  });
  writeJson(routesPath, {
    notificationRules: [{ id: "legacy-routes", routeKinds: ["group_message"], template: "" }]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  const config = repo.readConfig();

  assert.equal(fs.existsSync(adapterPath), true);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(routesPath), false);
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as GatewayDefinition;
  assert.equal(Array.isArray(adapter.notificationRules), false);
  assert.equal(Array.isArray(adapter.routeProfiles), false);
  assert.equal(adapter.roleNotificationRules, undefined);
  assert.equal(adapter.roleRouteNames, undefined);
  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition;
  assert.deepEqual(persona.notificationRules?.map(rule => rule.id), [
    "legacy-role",
    "legacy-routes",
    "legacy-adapter",
    "legacy-profile",
    "legacy-role-map",
    "role-panel-message"
  ]);
  assert.deepEqual(config.gateways[0].notificationRules?.map(rule => rule.id), [
    "legacy-role",
    "legacy-routes",
    "legacy-adapter",
    "legacy-profile",
    "legacy-role-map",
    "role-panel-message"
  ]);
  const momoPersona = JSON.parse(fs.readFileSync(path.join(rootDir, "data", "roles", "Momo", "personaConfig.json"), "utf8")) as GatewayDefinition;
  assert.deepEqual(momoPersona.notificationRules?.map(rule => rule.id), [
    "momo-profile",
    "role-panel-message"
  ]);
});

test("repository migration preserves existing personaConfig fields and rules", () => {
  const rootDir = makeTempRoot();
  const adapterPath = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  const personaPath = path.join(rootDir, "data", "roles", "Rabi", "personaConfig.json");
  writeJson(adapterPath, {
    enabled: true,
    messageAdapters: ["heartbeat"],
    gatewayPort: 8789,
    agentRoleId: "Rabi",
    notificationRules: [{ id: "adapter-new", routeKinds: ["heartbeat"], template: "from adapter" }]
  });
  writeJson(personaPath, {
    routeVariables: { tone: "warm" },
    notificationRules: [
      { id: "existing", routeKinds: ["private"], template: "keep me" },
      { id: "adapter-new", routeKinds: ["private"], template: "persona wins by id" }
    ]
  });

  const repo = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  repo.ensureDataDirs();

  const persona = JSON.parse(fs.readFileSync(personaPath, "utf8")) as GatewayDefinition & { routeVariables?: Record<string, string> };
  assert.deepEqual(persona.routeVariables, { tone: "warm" });
  assert.deepEqual(persona.notificationRules?.map(rule => [rule.id, rule.template]), [
    ["existing", "keep me"],
    ["adapter-new", "persona wins by id"],
    ["role-panel-message", ""]
  ]);
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
