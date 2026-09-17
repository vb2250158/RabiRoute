import test from "node:test";
import assert from "node:assert/strict";
import { addRemoteAgentTarget, localAgentTargetKey, normalizeRouteAgentTargets, primaryAgentInstanceBindings, remoteAgentTargetKey, removeRouteAgentTarget, resolvePrimaryAgentTarget } from "./routeAgentTargets.js";
import { normalizeGatewayDefinition } from "./gatewayConfigModel.js";

const binding = { instanceId: "node:one", agentId: "agent:one" };
const remote = { ...binding, provider: "codex" as const, id: remoteAgentTargetKey(binding) };
test("legacy migration restores local card and keeps the same remote primary without creating sessions", () => {
  const result = normalizeGatewayDefinition({ id: "example", gatewayPort: 8801, agentAdapters: ["codex", "dsh"], primaryAgentAdapter: "codex", agentInstanceBindings: { codex: binding } });
  assert.deepEqual(result.agentAdapters, ["codex", "dsh"]);
  assert.deepEqual(result.remoteAgentTargets, [remote]);
  assert.equal(result.primaryAgentTarget, remote.id);
  assert.equal(result.codexThreadId, undefined);
  assert.equal("agentInstanceBindings" in result, false);
  assert.deepEqual(normalizeGatewayDefinition(result), result);
});
test("multiple same-provider instances coexist and only exact primary projects into bridge", () => {
  const base = normalizeRouteAgentTargets({ agentAdapters: ["codex" as const], primaryAgentTarget: localAgentTargetKey("codex") });
  const first = addRemoteAgentTarget(base, remote);
  const second = addRemoteAgentTarget(first, { ...remote, agentId: "second" });
  assert.equal(second.remoteAgentTargets.length, 2);
  assert.equal(primaryAgentInstanceBindings(second), undefined);
  assert.deepEqual(primaryAgentInstanceBindings({ ...second, primaryAgentTarget: remote.id }), { codex: binding });
  assert.throws(() => addRemoteAgentTarget(second, { ...remote, provider: "dsh" }), /cannot change provider/);
});
test("explicit missing or removed primary never falls back and remote-only routes remain selectable", () => {
  const definition = { agentAdapters: [], remoteAgentTargets: [remote], primaryAgentTarget: remote.id };
  assert.equal(resolvePrimaryAgentTarget(definition)?.provider, "codex");
  assert.equal(resolvePrimaryAgentTarget(removeRouteAgentTarget(definition, remote.id)), undefined);
  assert.equal(resolvePrimaryAgentTarget({ ...definition, primaryAgentTarget: "remote:missing:missing" }), undefined);
});
test("explicit new target collection supersedes invalid legacy input", () => {
  const result = normalizeRouteAgentTargets({ agentAdapters: ["codex" as const], remoteAgentTargets: [], agentInstanceBindings: { invalid: binding }, primaryAgentAdapter: "codex" as const });
  assert.equal(result.primaryAgentTarget, "local:codex");
  assert.equal(result.remoteAgentTargets.length, 0);
});
test("remote-only primary retains managed policies and secretary pools are target scoped", () => {
  const second = { ...remote, agentId: "second", id: remoteAgentTargetKey({ ...binding, agentId: "second" }) };
  const result = normalizeGatewayDefinition({ id: "example", gatewayPort: 8801, agentAdapters: [], remoteAgentTargets: [remote, second], primaryAgentTarget: remote.id,
    messageProcessingAgents: { codex: { enabled: true } }, codexPlanAssistantEnabled: true,
    codexPlanAssistantSessions: [
      { threadId: "019f0000-0000-7000-8000-000000000021", threadName: "Secretary A", index: 1, workspace: "/remote/a", agentTargetId: remote.id },
      { threadId: "019f0000-0000-7000-8000-000000000022", threadName: "Secretary B", index: 1, workspace: "/remote/b", agentTargetId: second.id }
    ] });
  assert.equal(result.primaryAgentAdapter, "codex");
  assert.equal(result.messageProcessingAgents?.codex?.enabled, true);
  assert.equal(result.codexPlanAssistantSessions?.length, 2);
  assert.equal(normalizeGatewayDefinition({ ...result, primaryAgentTarget: second.id }).codexPlanAssistantSessions?.length, 2);
});
test("identity and duplicate validation rejects ambiguous remote bindings", () => {
  assert.throws(() => normalizeRouteAgentTargets({ remoteAgentTargets: [{ ...remote, id: "wrong" }] }), /identity/);
  assert.throws(() => normalizeRouteAgentTargets({ remoteAgentTargets: [remote, remote] }), /Duplicate/);
});
