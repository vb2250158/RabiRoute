import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerConfigRepository } from "./configRepository.js";
import { addRemoteAgentTarget, localAgentTargetKey, normalizeRouteAgentTargets, remoteAgentTargetKey, removeRouteAgentTarget, resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";

const first = { provider: "codex" as const, instanceId: "node:first", agentId: "agent:primary" };
const second = { provider: "codex" as const, instanceId: "node:second", agentId: "agent:primary" };
const localThreadId = "019f0000-0000-7000-8000-000000000001";

function fixture(initial: Record<string, unknown>) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-target-persistence-"));
  const file = path.join(rootDir, "data", "route", "main", "adapterConfig.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ gatewayPort: 8789, messageAdapters: ["heartbeat"], agentAdapters: ["codex"], codexThreadId: localThreadId, codexThreadName: "Local task", codexCwd: rootDir, ...initial }));
  const repository = new ManagerConfigRepository({ rootDir, managerPort: 8790 });
  return { rootDir, file, repository, dispose: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test("legacy remote binding migrates through repository without hiding local or changing primary", () => {
  const state = fixture({ primaryAgentAdapter: "codex", agentInstanceBindings: { codex: { instanceId: first.instanceId, agentId: first.agentId } } });
  try {
    const config = state.repository.readConfig();
    const migrated = config.gateways[0]!;
    assert.deepEqual(migrated.agentAdapters, ["codex"]);
    assert.equal(migrated.primaryAgentTarget, remoteAgentTargetKey(first));
    assert.equal(migrated.codexThreadId, localThreadId);
    assert.equal(migrated.codexThreadName, "Local task");
    state.repository.writeConfig(config);
    const saved = JSON.parse(fs.readFileSync(state.file, "utf8"));
    assert.equal(saved.agentInstanceBindings, undefined);
    assert.equal(saved.remoteAgentTargets.length, 1);
    assert.equal(state.repository.readConfig().gateways[0]!.primaryAgentTarget, remoteAgentTargetKey(first));
  } finally { state.dispose(); }
});

test("local and two same-provider remote targets survive save, selection and independent removal", () => {
  const state = fixture({ primaryAgentTarget: localAgentTargetKey("codex") });
  try {
    let config = state.repository.readConfig();
    config.gateways[0] = addRemoteAgentTarget(addRemoteAgentTarget(config.gateways[0]!, first), second);
    state.repository.writeConfig(config);
    for (const id of [localAgentTargetKey("codex"), remoteAgentTargetKey(first), remoteAgentTargetKey(second)]) {
      config = state.repository.readConfig();
      config.gateways[0] = normalizeRouteAgentTargets({ ...config.gateways[0]!, primaryAgentTarget: id });
      state.repository.writeConfig(config);
      const current = state.repository.readConfig().gateways[0]!;
      assert.equal(resolvePrimaryAgentTarget(current)?.id, id);
      assert.equal(current.remoteAgentTargets?.length, 2);
      assert.equal(current.codexThreadId, localThreadId);
      assert.deepEqual(current.agentAdapters, ["codex"]);
    }
    config = state.repository.readConfig();
    config.gateways[0] = removeRouteAgentTarget(config.gateways[0]!, remoteAgentTargetKey(first));
    state.repository.writeConfig(config);
    assert.equal(state.repository.readConfig().gateways[0]!.primaryAgentTarget, remoteAgentTargetKey(second));
    config = state.repository.readConfig();
    config.gateways[0] = removeRouteAgentTarget(config.gateways[0]!, remoteAgentTargetKey(second));
    state.repository.writeConfig(config);
    const removed = state.repository.readConfig().gateways[0]!;
    assert.equal(removed.primaryAgentTarget, "");
    assert.equal(resolvePrimaryAgentTarget(removed), undefined);
    assert.deepEqual(removed.agentAdapters, ["codex"]);
    assert.deepEqual(removed.remoteAgentTargets, []);
    assert.equal(removed.codexThreadId, localThreadId);
  } finally { state.dispose(); }
});

test("explicit remote-only selection survives repository normalization without a local fallback", () => {
  const state = fixture({ agentAdapters: [], remoteAgentTargets: [{ ...first, id: remoteAgentTargetKey(first) }], primaryAgentTarget: remoteAgentTargetKey(first) });
  try {
    state.repository.writeConfig(state.repository.readConfig());
    const current = state.repository.readConfig().gateways[0]!;
    assert.deepEqual(current.agentAdapters, []);
    assert.equal(current.primaryAgentAdapter, "codex");
    assert.deepEqual(resolvePrimaryAgentTarget(current)?.binding, { instanceId: first.instanceId, agentId: first.agentId });
  } finally { state.dispose(); }
});
