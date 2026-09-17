import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayDefinition } from "../src/types";
import { addRouteAgent, applyRouteAgentDraft, removeRouteAgent, selectRouteAgent } from "../src/routeAgentTargetEditor";
import { remoteAgentTargetKey, resolvePrimaryAgentTarget } from "../../src/shared/routeAgentTargets";

const first = { instanceId: "computer-a", agentId: "codex-one" };
const second = { instanceId: "computer-b", agentId: "codex-one" };
function route(): GatewayDefinition {
  return { id: "route", agentAdapters: ["codex", "dsh"], primaryAgentAdapter: "codex", codexThreadId: "local-thread", codexCwd: "C:/Project", dshSessionId: "local-dsh" } as GatewayDefinition;
}

test("adding multiple remote Codex targets preserves local form and primary; same target deduplicates", () => {
  const draft = route();
  addRouteAgent(draft, "codex", first.instanceId, first.agentId);
  addRouteAgent(draft, "codex", second.instanceId, second.agentId);
  addRouteAgent(draft, "codex", first.instanceId, first.agentId);
  assert.deepEqual(draft.agentAdapters, ["codex", "dsh"]);
  assert.equal(draft.remoteAgentTargets?.length, 2);
  assert.equal(draft.primaryAgentTarget, "local:codex");
  assert.equal(draft.codexThreadId, "local-thread");
  assert.equal(draft.codexCwd, "C:/Project");
});

test("select and remove operate on exact instance identity without selecting a fallback", () => {
  const draft = route();
  addRouteAgent(draft, "codex", first.instanceId, first.agentId);
  addRouteAgent(draft, "codex", second.instanceId, second.agentId);
  selectRouteAgent(draft, remoteAgentTargetKey(second));
  assert.deepEqual(resolvePrimaryAgentTarget(draft)?.binding, second);
  removeRouteAgent(draft, remoteAgentTargetKey(first));
  assert.deepEqual(resolvePrimaryAgentTarget(draft)?.binding, second);
  removeRouteAgent(draft, "local:codex");
  assert.deepEqual(draft.agentAdapters, ["dsh"]);
  assert.equal(draft.codexThreadId, "local-thread");
  assert.deepEqual(resolvePrimaryAgentTarget(draft)?.binding, second);
  removeRouteAgent(draft, remoteAgentTargetKey(second));
  assert.equal(draft.primaryAgentTarget, "");
  assert.equal(resolvePrimaryAgentTarget(draft), undefined);
  addRouteAgent(draft, "codex");
  assert.equal(resolvePrimaryAgentTarget(draft), undefined);
  selectRouteAgent(draft, "local:codex");
  assert.equal(resolvePrimaryAgentTarget(draft)?.id, "local:codex");
});

test("legacy migration retains remote primary and local fields across JSON round trip", () => {
  const draft = route();
  draft.agentInstanceBindings = { codex: first };
  applyRouteAgentDraft(draft);
  assert.equal("agentInstanceBindings" in draft, false);
  assert.equal(draft.primaryAgentTarget, remoteAgentTargetKey(first));
  const reloaded: GatewayDefinition = JSON.parse(JSON.stringify(draft));
  applyRouteAgentDraft(reloaded);
  assert.deepEqual(reloaded, JSON.parse(JSON.stringify(draft)));
  assert.equal(reloaded.codexThreadId, "local-thread");
  assert.deepEqual(reloaded.agentAdapters, ["codex", "dsh"]);
  selectRouteAgent(reloaded, "remote:missing:missing");
  assert.equal(reloaded.primaryAgentTarget, remoteAgentTargetKey(first));
});
