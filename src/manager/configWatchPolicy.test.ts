import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { configWatchDirectoryRules, configWatchEventMatches } from "./configWatchPolicy.js";

test("config watch rules ignore plan, memory, history, and log churn beside config files", () => {
  const routeRoot = path.resolve("data/route");
  const rolesRoot = path.resolve("data/roles");
  const routeConfig = path.join(routeRoot, "main", "adapterConfig.json");
  const personaConfig = path.join(rolesRoot, "Rabi", "personaConfig.json");
  const rules = configWatchDirectoryRules(routeRoot, rolesRoot, [routeConfig, personaConfig]);

  const routeRule = rules.get(path.dirname(routeConfig));
  const roleRule = rules.get(path.dirname(personaConfig));
  assert.ok(routeRule);
  assert.ok(roleRule);
  assert.equal(configWatchEventMatches(routeRule, "rename", "manager-runtime.jsonl"), false);
  assert.equal(configWatchEventMatches(routeRule, "change", "history.jsonl"), false);
  assert.equal(configWatchEventMatches(roleRule, "rename", "plans"), false);
  assert.equal(configWatchEventMatches(roleRule, "change", "memory.json"), false);
  assert.equal(configWatchEventMatches(routeRule, "change", "adapterConfig.json"), true);
  assert.equal(configWatchEventMatches(roleRule, "rename", "personaConfig.json"), true);
});

test("config root discovery reacts only to directory-entry changes", () => {
  const routeRoot = path.resolve("data/route");
  const rolesRoot = path.resolve("data/roles");
  const rules = configWatchDirectoryRules(routeRoot, rolesRoot, []);
  const routeRule = rules.get(routeRoot);
  assert.ok(routeRule);
  assert.equal(configWatchEventMatches(routeRule, "change", "runtime.log"), false);
  assert.equal(configWatchEventMatches(routeRule, "rename", "new-route"), true);
});
