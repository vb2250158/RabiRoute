import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { normalizeAllowedWorkspaces, resolveRealDirectory } from "../lib/cwd-policy.mjs";
import { agentCatalog, configureInstanceAgent, resolveInstanceAgent as resolveTaskAgent, registerManagedSession } from "../lib/instance-agents.mjs";

const config = { defaultWorkspace: resolveRealDirectory(os.tmpdir()), allowedWorkspaces: normalizeAllowedWorkspaces([], os.tmpdir()),
  agents: [{ agentId: "default", name: "Existing Agent", provider: "codex-desktop", enabled: true, workspace: resolveRealDirectory(os.tmpdir()), sessionId: "task-a" }] };
const resolveInstanceAgent = (config, task) => resolveTaskAgent(config, { threadId: "explicit-task", ...task });
test("existing catalog identities survive; legacy single-task settings do not synthesize a default Agent", () => {
  assert.deepEqual(agentCatalog({ agentType: "codex-desktop", codexDesktop: { threadId: "old-task" } }), []);
  assert.equal(agentCatalog(config)[0].agentId, "default");
  const next = configureInstanceAgent(config, { name: "Second", provider: "codex-desktop", sessionId: "task-b" });
  assert.equal(next.agents.length, 2);
  const second = next.agents[1];
  assert.notEqual(second.agentId, "default");
  assert.equal(resolveInstanceAgent(next, { agentId: second.agentId, targetAgent: "codex-desktop" }).sessionId, "task-b");
  const disabled = configureInstanceAgent(next, { agentId: second.agentId, enabled: false });
  assert.throws(() => resolveInstanceAgent(disabled, { agentId: second.agentId, targetAgent: "codex-desktop" }), /disabled/);
  assert.equal(resolveInstanceAgent(disabled, { agentId: "default", targetAgent: "codex-desktop" }).sessionId, "task-a");
  assert.throws(() => resolveInstanceAgent(next, { agentId: second.agentId, targetAgent: "dsh" }), /provider/);
  assert.throws(() => configureInstanceAgent(next, { agentId: second.agentId, provider: "dsh" }), /new Agent/);
});

test("every delivery requires explicit Agent, provider and opaque session identity without rebinding", () => {
  for (const request of [{ targetAgent: "codex-desktop", threadId: "task-b" }, { agentId: "default", threadId: "task-b" },
    { agentId: "default", targetAgent: "codex-desktop" }, { agentId: "default", targetAgent: "codex-desktop", threadId: " task-b" }]) {
    assert.throws(() => resolveTaskAgent(config, request), /Explicit/);
  }
  const before = structuredClone(config);
  assert.equal(resolveTaskAgent(config, { agentId: "default", targetAgent: "codex-desktop", threadId: "task-b" }).sessionId, "task-a");
  assert.deepEqual(config, before);
});
test("enrolled connector uses Manager enablement while preserving exact identity", () => {
  const localDisabled = configureInstanceAgent(config, { agentId: "default", enabled: false });
  const managed = { ...localDisabled, nodeCredential: "test-only-node-credential" };
  assert.equal(resolveInstanceAgent(managed, { agentId: "default", targetAgent: "codex-desktop" }).sessionId, "task-a");
  // Preserve the old false only in the first registration catalog, then retire it on save.
  assert.equal(agentCatalog(managed)[0].enabled, false);
  const updated = configureInstanceAgent(managed, { agentId: "default", name: "Updated" });
  assert.equal(Object.hasOwn(updated.agents[0], "enabled"), false);
  assert.equal(agentCatalog(updated)[0].enabled, true);
  assert.throws(() => configureInstanceAgent(managed, { agentId: "default", enabled: false }), /Manager authorization endpoint/);
  assert.throws(() => resolveInstanceAgent(managed, { agentId: "unknown", targetAgent: "codex-desktop" }), /missing/);
  assert.throws(() => resolveInstanceAgent(managed, { agentId: "default", targetAgent: "dsh" }), /provider/);
});

test("instance catalog excludes private DSH connection settings", () => {
  const next = configureInstanceAgent(config, { provider: "dsh", sessionId: "session-b", dshBaseUrl: "http://127.0.0.1:4510" });
  assert.equal(agentCatalog(next)[1].dsh, undefined);
});

test("managed task ownership survives settings changes and is cleared when rebinding the primary", () => {
  const registered = registerManagedSession(config, "default", "task-worker");
  assert.deepEqual(agentCatalog(registered)[0].managedSessionIds, ["task-worker"]);
  assert.equal(registerManagedSession(registered, "default", "task-worker"), registered);
  assert.deepEqual(configureInstanceAgent(registered, { agentId: "default", model: "new-model" }).agents[0].managedSessionIds, ["task-worker"]);
  assert.equal(configureInstanceAgent(registered, { agentId: "default", sessionId: "task-new" }).agents[0].managedSessionIds, undefined);
  assert.throws(() => configureInstanceAgent(registered, { provider: "codex-desktop", sessionId: "task-worker" }), /belongs/);
});
