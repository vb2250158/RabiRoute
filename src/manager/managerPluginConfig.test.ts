import assert from "node:assert/strict";
import test from "node:test";
import { builtinManagerPluginDefinitions } from "./builtinManagerPlugins.js";
import type { ManagerConfig } from "./configRepository.js";
import { normalizeManagerPluginConfig } from "./managerPluginConfig.js";

test("Manager plugin config enables every builtin plugin by default with stable desired revisions", () => {
  const first = normalizeManagerPluginConfig({});
  const second = normalizeManagerPluginConfig({});
  const builtinIds = builtinManagerPluginDefinitions().map(definition => definition.instanceId);

  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(first.desired.map(item => item.definition.instanceId), builtinIds);
  assert.equal(first.desired.every(item => item.enabled), true);
  assert.deepEqual(
    first.desired.map(item => item.revision),
    second.desired.map(item => item.revision)
  );
  assert.equal(first.desired.every(item => /^[a-f0-9]{64}$/.test(item.revision)), true);
});

test("Manager plugin config may disable optional builtin plugins and changes only their desired revision", () => {
  const defaults = normalizeManagerPluginConfig({});
  const normalized = normalizeManagerPluginConfig({
    managerPlugins: {
      "manager:desktop": { enabled: false }
    }
  });
  const defaultById = new Map(defaults.desired.map(item => [item.definition.instanceId, item]));
  const normalizedById = new Map(normalized.desired.map(item => [item.definition.instanceId, item]));

  assert.equal(normalizedById.get("manager:desktop")?.enabled, false);
  assert.notEqual(
    normalizedById.get("manager:desktop")?.revision,
    defaultById.get("manager:desktop")?.revision
  );
  for (const [instanceId, item] of normalizedById) {
    if (instanceId === "manager:desktop") continue;
    assert.equal(item.enabled, true);
    assert.equal(item.revision, defaultById.get(instanceId)?.revision);
  }
});

test("Manager core remains enabled and reports attempts to disable it", () => {
  const normalized = normalizeManagerPluginConfig({
    managerPlugins: {
      "manager:core": { enabled: false }
    }
  });
  const core = normalized.desired.find(item => item.definition.instanceId === "manager:core");

  assert.equal(core?.enabled, true);
  assert.deepEqual(normalized.diagnostics, [{
    code: "required_plugin_cannot_disable",
    instanceId: "manager:core",
    message: "Required Manager plugin cannot be disabled: manager:core"
  }]);
});


test("Manager plugin config ignores unknown instances and executable configuration fields", () => {
  const config = {
    managerPlugins: {
      "manager:desktop": {
        enabled: false,
        path: "C:/plugins/desktop.js",
        package: "third-party-plugin",
        command: "node plugin.js",
        url: "https://example.invalid/plugin.js",
        env: { TOKEN: "secret" }
      },
      "package:unknown": {
        enabled: true,
        url: "https://example.invalid/unknown.js"
      }
    }
  } as unknown as ManagerConfig;

  const normalized = normalizeManagerPluginConfig(config);

  assert.equal(
    normalized.desired.some(item => item.definition.instanceId === "package:unknown"),
    false
  );
  assert.equal(
    normalized.desired.find(item => item.definition.instanceId === "manager:desktop")?.enabled,
    false
  );
  assert.deepEqual(normalized.diagnostics, [
    {
      code: "unsupported_plugin_config",
      instanceId: "manager:desktop",
      message: "Unsupported Manager plugin config fields for manager:desktop: command, env, package, path, url"
    },
    {
      code: "unknown_plugin",
      instanceId: "package:unknown",
      message: "Unknown Manager plugin instance: package:unknown"
    }
  ]);
  assert.equal(JSON.stringify(normalized.desired).includes("example.invalid"), false);
  assert.equal(JSON.stringify(normalized.desired).includes("third-party-plugin"), false);
  assert.equal(JSON.stringify(normalized.desired).includes("TOKEN"), false);
});


test("Manager plugin config accepts only boolean enabled values", () => {
  const config = {
    managerPlugins: {
      "manager:speech": { enabled: "false" },
      "manager:performance": "disabled"
    }
  } as unknown as ManagerConfig;

  const normalized = normalizeManagerPluginConfig(config);

  assert.equal(
    normalized.desired.find(item => item.definition.instanceId === "manager:speech")?.enabled,
    true
  );
  assert.equal(
    normalized.desired.find(item => item.definition.instanceId === "manager:performance")?.enabled,
    true
  );
  assert.deepEqual(normalized.diagnostics, [
    {
      code: "unsupported_plugin_config",
      instanceId: "manager:performance",
      message: "Manager plugin config must contain only an optional boolean enabled field: manager:performance"
    },
    {
      code: "unsupported_plugin_config",
      instanceId: "manager:speech",
      message: "Unsupported Manager plugin config fields for manager:speech: enabled"
    }
  ]);
});
