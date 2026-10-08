import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { memoryConsolidationAgentStatePath } from "../memoryConsolidationAgent.js";
import { memoryConsolidationHookScope, type ConsolidationHookTarget } from "./memoryConsolidationHookScope.js";
import type { CodexHookContextRequest } from "./codexHookContext.js";

test("dedicated hook resolves only an explicitly identified delivered run from its own route", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-consolidation-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target: ConsolidationHookTarget = { roleId: "Example", roleDir: path.join(root, "role"), dataDir: path.join(root, "route") };
  const other: ConsolidationHookTarget = { roleId: "Other", roleDir: path.join(root, "other-role"), dataDir: path.join(root, "other-route") };
  for (const [entry, threadId] of [[target, "session-dedicated"], [other, "session-other"]] as const) {
    const stateFile = memoryConsolidationAgentStatePath(entry.dataDir);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(),
      binding: { agentAdapter: "dsh", threadId, threadName: "整理", workspace: root } }));
  }
  const runsDir = path.join(target.roleDir, "memory", "consolidation-runs");
  fs.mkdirSync(runsDir, { recursive: true });
  for (const [id, ids, deliveredAt, status] of [
    ["run-one", ["memory-one"], "2026-01-01T00:00:00Z", "requested"],
    ["run-two", ["memory-two", "memory-three"], "2026-01-02T00:00:00Z", "requested"],
    ["run-undelivered", ["memory-undelivered"], undefined, "requested"],
    ["run-completed", ["memory-completed"], "2026-01-01T00:00:00Z", "completed"]
  ] as const) {
    fs.writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify({ id, roleDir: target.roleDir,
      requestedAt: "2026-01-01T00:00:00Z", deliveredAt, status, inputMemoryIds: ids }));
  }
  const request = { sessionId: "session-dedicated", agentType: "dsh", eventName: "UserPromptSubmit" } as CodexHookContextRequest;
  const scope = (req: CodexHookContextRequest, role: string, runId?: string, targets = [target, other]) =>
    memoryConsolidationHookScope(req, role, runId, targets);
  assert.deepEqual(scope(request, "Example", "run-two"), { runId: "run-two", inputMemoryIds: ["memory-two", "memory-three"] });
  assert.deepEqual(scope(request, "Example"), { inputMemoryIds: [] });
  assert.deepEqual(scope(request, "Example", "run-unknown"), { inputMemoryIds: [] });
  assert.deepEqual(scope(request, "Example", "run-undelivered"), { inputMemoryIds: [] });
  assert.deepEqual(scope(request, "Example", "run-completed"), { inputMemoryIds: [] });
  assert.deepEqual(scope(request, "Other", "run-two"), { inputMemoryIds: [] });
  assert.deepEqual(scope({ ...request, agentType: "codex" }, "Example", "run-two"), { inputMemoryIds: [] });
  assert.deepEqual(scope(request, "Example", "run-two", [target, target]), { inputMemoryIds: [] });
  assert.equal(scope({ ...request, sessionId: "session-ordinary" }, "Example", "run-two"), undefined);
});
