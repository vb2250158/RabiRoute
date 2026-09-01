import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  collectWatchedConfigFiles,
  type ConfigWatchDirectoryReader
} from "./configWatchSnapshot.js";

test("config watcher returns a bounded partial snapshot when a NAS directory stalls", async () => {
  const routeRoot = path.resolve("runtime", "routes");
  const rolesRoot = path.resolve("runtime", "roles");
  const reader: ConfigWatchDirectoryReader = async directory => {
    if (directory === rolesRoot) return new Promise(() => undefined);
    return [{ name: "route-a", isDirectory: () => true }];
  };

  const startedAt = Date.now();
  const result = await collectWatchedConfigFiles({
    routeRoot,
    rolesRoot,
    timeoutMs: 20,
    readDirectory: reader,
    adapterConfigPath: name => path.join(routeRoot, name, "adapterConfig.json"),
    personaConfigPath: name => path.join(rolesRoot, name, "personaConfig.json"),
    fileExists: async () => true
  });

  assert.ok(Date.now() - startedAt < 250);
  assert.equal(result.partial, true);
  assert.deepEqual(result.files, [path.join(routeRoot, "route-a", "adapterConfig.json")]);
  assert.match(result.errors.join("\n"), /roles/i);
});

test("config watcher treats a transient directory read error as partial instead of throwing", async () => {
  const routeRoot = path.resolve("runtime", "routes");
  const rolesRoot = path.resolve("runtime", "roles");
  const result = await collectWatchedConfigFiles({
    routeRoot,
    rolesRoot,
    timeoutMs: 20,
    readDirectory: async directory => {
      if (directory === rolesRoot) throw Object.assign(new Error("temporary SMB failure"), { code: "UNKNOWN" });
      return [];
    },
    adapterConfigPath: name => path.join(routeRoot, name, "adapterConfig.json"),
    personaConfigPath: name => path.join(rolesRoot, name, "personaConfig.json"),
    fileExists: async () => true
  });

  assert.equal(result.partial, true);
  assert.deepEqual(result.files, []);
  assert.match(result.errors.join("\n"), /UNKNOWN/);
});


test("config watcher includes explicit Manager configuration files", async () => {
  const routeRoot = path.resolve("runtime", "routes");
  const rolesRoot = path.resolve("runtime", "roles");
  const managerConfig = path.resolve("runtime", "manager.json");
  const result = await collectWatchedConfigFiles({
    routeRoot,
    rolesRoot,
    explicitFiles: [managerConfig],
    readDirectory: async () => [],
    adapterConfigPath: name => path.join(routeRoot, name, "adapterConfig.json"),
    personaConfigPath: name => path.join(rolesRoot, name, "personaConfig.json"),
    fileExists: async () => true
  });

  assert.deepEqual(result.files, [managerConfig]);
});

test("config watcher ignores route runtime directories without adapterConfig.json", async () => {
  const routeRoot = path.resolve("runtime", "routes");
  const rolesRoot = path.resolve("runtime", "roles");
  const result = await collectWatchedConfigFiles({
    routeRoot,
    rolesRoot,
    readDirectory: async directory => directory === routeRoot
      ? [{ name: "retired-route-logs", isDirectory: () => true }]
      : [],
    adapterConfigPath: name => path.join(routeRoot, name, "adapterConfig.json"),
    personaConfigPath: name => path.join(rolesRoot, name, "personaConfig.json"),
    fileExists: async () => false
  });

  assert.equal(result.partial, false);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.errors, []);
});
