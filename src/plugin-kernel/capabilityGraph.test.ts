import assert from "node:assert/strict";
import test from "node:test";
import { planCapabilityGraph } from "./capabilityGraph.js";
import type { PluginCandidate, PluginManifest } from "./types.js";

function candidate(instanceId: string, provides: string[], requires: string[]): PluginCandidate {
  const manifest: PluginManifest = {
    schemaVersion: 2, id: `io.test.${instanceId}`, version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides, requires, optional: [], permissions: []
  };
  return { instanceId, revision: "one", manifest, config: {}, entry: { execution: "in_process", path: "virtual.mjs" } };
}

test("planCapabilityGraph orders providers before consumers", () => {
  const plan = planCapabilityGraph([
    candidate("consumer", [], ["route.query@1"]), candidate("provider", ["route.query@1"], [])
  ], new Set());
  assert.deepEqual(plan.activationOrder, ["provider", "consumer"]);
  assert.equal(plan.waiting.size, 0);
});

test("planCapabilityGraph isolates missing dependency chains", () => {
  const plan = planCapabilityGraph([
    candidate("independent", [], []),
    candidate("provider", ["route.query@1"], ["storage.route@1"]),
    candidate("consumer", [], ["route.query@1"])
  ], new Set());
  assert.deepEqual(plan.activationOrder, ["independent"]);
  assert.deepEqual(plan.waiting.get("provider"), ["storage.route@1"]);
  assert.deepEqual(plan.waiting.get("consumer"), ["route.query@1"]);
});

test("planCapabilityGraph rejects ambiguous providers and cycles", () => {
  assert.throws(() => planCapabilityGraph([
    candidate("left", ["route.query@1"], []), candidate("right", ["route.query@1"], [])
  ], new Set()), /multiple providers/);
  assert.throws(() => planCapabilityGraph([
    candidate("left", ["left@1"], ["right@1"]), candidate("right", ["right@1"], ["left@1"])
  ], new Set()), /dependency cycle/);
});
