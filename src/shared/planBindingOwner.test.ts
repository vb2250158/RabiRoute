import test from "node:test";
import assert from "node:assert/strict";
import { planBindingMatchesSource, planBindingSourceKey, planBindingTargetKey } from "./planBindingOwner.js";

test("plan owner matches exact instance and provider without requiring an unadvertised Agent ID", () => {
  const local = { agentType: "codex", sessionId: "same-session" };
  const remote = { ...local, instanceBinding: { instanceId: "test-one", agentId: "configured-agent" } };
  const source = { sessionId: local.sessionId, agentType: "codex", sourceInstance: { instanceId: "test-one" } };
  assert.equal(planBindingMatchesSource(remote, source), true);
  assert.equal(planBindingMatchesSource(local, source), false);
  assert.equal(planBindingMatchesSource(remote, { sessionId: local.sessionId }), false);
  assert.equal(planBindingMatchesSource(remote, { ...source, sourceInstance: { instanceId: "test-two" } }), false);
  assert.equal(planBindingMatchesSource(remote, { ...source, agentType: "dsh" }), false);
  assert.equal(planBindingMatchesSource(remote, { ...source, sourceInstance: { instanceId: "test-one", agentId: "other" } }), false);
  assert.equal(planBindingMatchesSource(remote, { ...source, sourceInstance: { instanceId: "test-one", agentId: "configured-agent" } }), true);
});

test("plan owner preserves explicit peer identity and legacy local storage keys", () => {
  const local = { agentType: "codex", sessionId: "same-session" };
  const binding = { ...local, instanceBinding: { ownerDeviceId: "peer-one", instanceId: "test-one", agentId: "agent" } };
  assert.equal(planBindingMatchesSource(local, { sessionId: local.sessionId }), true);
  assert.equal(planBindingMatchesSource(binding, { ...local, sourceInstance: { instanceId: "test-one" } }), false);
  assert.equal(planBindingMatchesSource(binding, { ...local, sourceInstance: { ownerDeviceId: "peer-one", instanceId: "test-one" } }), true);
  const key = planBindingSourceKey({ ...local, sourceInstance: { instanceId: "test-one" } });
  assert.notEqual(key, planBindingSourceKey(local));
  assert.notEqual(key, planBindingSourceKey({ ...local, sourceInstance: { instanceId: "test-two" } }));
  assert.notEqual(key, planBindingSourceKey({ ...local, sourceInstance: { ownerDeviceId: "peer-one", instanceId: "test-one" } }));
  assert.equal(planBindingSourceKey(local), local.sessionId);
});

test("trusted configured Agent IDs separate same-node session state without changing unknown-Agent LAN keys", () => {
  const source = { agentType: "codex", sessionId: "same-session", sourceInstance: { instanceId: "test-one" } };
  const oldLanKey = JSON.stringify(["remote", "", "test-one", "codex", "same-session"]);
  assert.equal(planBindingSourceKey(source), oldLanKey, "a provider alias does not become a configured Agent ID");
  const knownA = { ...source, sourceInstance: { ...source.sourceInstance, agentId: "configured-a" } };
  const knownB = { ...source, sourceInstance: { ...source.sourceInstance, agentId: "configured-b" } };
  assert.equal(planBindingSourceKey(knownA), JSON.stringify(["remote", "", "test-one", "codex", "same-session", "configured-a"]));
  assert.notEqual(planBindingSourceKey(knownA), planBindingSourceKey(knownB));
  assert.notEqual(planBindingSourceKey(knownA), oldLanKey);
  const binding = { agentType: "codex", sessionId: "same-session", instanceBinding: { instanceId: "test-one", agentId: "configured-a" } };
  assert.equal(planBindingMatchesSource(binding, knownA), true);
  assert.equal(planBindingMatchesSource(binding, knownB), false);
  assert.equal(planBindingMatchesSource(binding, source), true, "trusted node/provider/session remains usable when no configured Agent ID was advertised");
  assert.equal(planBindingSourceKey({ sessionId: "same-session" }), "same-session");
});

test("target owner key retains remote coordinates and treats cwd as execution metadata", () => {
  const binding = { agentType: "codex", sessionId: "task", workspace: "/one",
    instanceBinding: { instanceId: "pc-one", agentId: "agent" } };
  assert.equal(planBindingTargetKey(binding), planBindingTargetKey({ ...binding, workspace: "/two" }));
  assert.notEqual(planBindingTargetKey(binding), planBindingTargetKey({ ...binding, instanceBinding: { ...binding.instanceBinding, instanceId: "pc-two" } }));
  assert.notEqual(planBindingTargetKey(binding), planBindingTargetKey({ ...binding, instanceBinding: undefined }));
  assert.notEqual(planBindingTargetKey({ agentType: "dsh", sessionId: "task", baseUrl: "http://one" }),
    planBindingTargetKey({ agentType: "dsh", sessionId: "task", baseUrl: "http://two" }));
});
