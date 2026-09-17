import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import type { CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import { reconcilePlanSecretaryBindingsForWorkspace, resolvePlanSecretaryAssignment } from "./planSecretaryAssignment.js";

function plan(id: string, secretaryBinding?: PlanItem["secretaryBinding"]): PlanItem {
  return {
    id,
    title: id,
    focus: id,
    status: "执行中",
    archiveStatus: "未归档",
    attachments: [],
    steps: [{ id: "run", title: "执行" }],
    secretaryBinding,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    keywords: ["计划"]
  };
}

const sessions: CodexPlanAssistantSession[] = [
  {
    threadId: "019fa314-2c07-7523-896f-9bb6b638054a",
    threadName: "主人格 协助处理计划1",
    workspace: "C:\\workspace\\route",
    index: 1
  },
  {
    threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
    threadName: "主人格 协助处理计划2",
    workspace: "C:\\workspace\\route",
    index: 2
  }
];

test("exact target assignment never reuses a different owner's colliding thread", () => {
  const pools = ["local:codex", "remote-a", "remote-b"].map((agentTargetId) => ({ ...sessions[0]!, agentTargetId }));
  const first = resolvePlanSecretaryAssignment(plan("target-plan"), pools, "first", "remote-a")!;
  const second = resolvePlanSecretaryAssignment(plan("target-plan", first.binding), pools, "second", "remote-b")!;
  assert.equal(first.target.agentTargetId, "remote-a");
  assert.equal(second.target.agentTargetId, "remote-b");
  assert.equal(second.binding.agentTargetId, "remote-b");
  assert.equal(second.binding.assignedAt, "second");
  assert.equal(second.changed, true);
  const repeat = resolvePlanSecretaryAssignment(plan("target-plan", second.binding), pools, "third", "remote-b")!;
  assert.equal(repeat.changed, false);
  assert.equal(repeat.binding.assignedAt, "second");
  assert.equal(resolvePlanSecretaryAssignment(plan("target-plan"), pools), undefined);
  assert.equal(resolvePlanSecretaryAssignment(plan("target-plan"), pools, "now", "missing"), undefined);
});

test("legacy sessions cannot be attributed to an exact target during assignment", () => {
  assert.equal(resolvePlanSecretaryAssignment(plan("legacy-plan"), sessions, "now", "remote-a"), undefined);
  const legacy = resolvePlanSecretaryAssignment(plan("legacy-plan"), sessions, "old")!;
  const migrated = sessions.map((session) => ({ ...session, agentTargetId: "remote-a" }));
  const selected = resolvePlanSecretaryAssignment(plan("legacy-plan", legacy.binding), migrated, "new", "remote-a")!;
  assert.equal(selected.changed, true);
  assert.equal(selected.binding.assignedAt, "new");
  assert.equal(selected.binding.agentTargetId, "remote-a");
});

test("explicit provider ownership prevents reuse of a colliding UUID", () => {
  const pool = [{ ...sessions[0]!, agentAdapter: "antigravity" as const, agentTargetId: "remote-a" }];
  const old = { agentType: "codex" as const, agentTargetId: "remote-a", sessionId: pool[0]!.threadId, workspace: pool[0]!.workspace, assignedAt: "old" };
  const result = resolvePlanSecretaryAssignment(plan("provider-plan", old), pool, "new", "remote-a")!;
  assert.equal(result.binding.agentType, "antigravity");
  assert.equal(result.changed, true);
  assert.equal(result.binding.assignedAt, "new");
});

test("plan secretary assignment reuses an exact configured binding", () => {
  const existing = {
    agentType: "codex" as const,
    sessionId: sessions[1]!.threadId,
    sessionTitle: sessions[1]!.threadName,
    workspace: sessions[1]!.workspace,
    assignedAt: "2026-08-01T00:00:00.000Z"
  };
  const result = resolvePlanSecretaryAssignment(plan("plan-reuse", existing), sessions, "2026-08-06T00:00:00.000Z");

  assert.equal(result?.target.threadId, sessions[1]!.threadId);
  assert.equal(result?.binding.assignedAt, existing.assignedAt);
  assert.equal(result?.changed, false);
});

test("plan secretary assignment reuses a binding with an equivalent Windows workspace path", () => {
  const existing = {
    agentType: "codex" as const,
    sessionId: sessions[1]!.threadId,
    sessionTitle: sessions[1]!.threadName,
    workspace: "\\\\?\\C:\\workspace\\route\\",
    assignedAt: "2026-08-01T00:00:00.000Z"
  };

  const result = resolvePlanSecretaryAssignment(plan("plan-alias", existing), sessions, "2026-08-06T00:00:00.000Z");

  assert.equal(result?.target.threadId, sessions[1]!.threadId);
  assert.equal(result?.binding.assignedAt, existing.assignedAt);
  assert.equal(result?.changed, false);
});

test("unassigned plans receive one stable secretary instead of broadcasting to the pool", () => {
  const first = resolvePlanSecretaryAssignment(plan("plan-stable"), sessions, "2026-08-06T00:00:00.000Z");
  const second = resolvePlanSecretaryAssignment(plan("plan-stable"), [...sessions].reverse(), "2026-08-07T00:00:00.000Z");

  assert.ok(first);
  assert.equal(second?.target.threadId, first?.target.threadId);
  assert.equal(first?.changed, true);
  assert.equal(first?.binding.assignedAt, "2026-08-06T00:00:00.000Z");
});

test("a removed secretary binding is reassigned to a configured session", () => {
  const result = resolvePlanSecretaryAssignment(plan("plan-removed", {
    agentType: "codex",
    sessionId: "019fa314-2c07-7523-896f-9bb6b6380999",
    sessionTitle: "已移除秘书",
    workspace: "C:\\workspace\\route",
    assignedAt: "2026-08-01T00:00:00.000Z"
  }), sessions, "2026-08-06T00:00:00.000Z");

  assert.ok(sessions.some((session) => session.threadId === result?.target.threadId));
  assert.equal(result?.changed, true);
  assert.equal(result?.binding.assignedAt, "2026-08-06T00:00:00.000Z");
});

test("no configured secretary leaves the plan unassigned", () => {
  assert.equal(resolvePlanSecretaryAssignment(plan("plan-none"), []), undefined);
});

test("workspace reconciliation clears only secretary bindings outside the Primary Persona workspace", () => {
  const retained = plan("plan-retained", {
    agentType: "codex",
    sessionId: sessions[0]!.threadId,
    sessionTitle: sessions[0]!.threadName,
    workspace: "\\\\?\\C:\\workspace\\route\\",
    assignedAt: "2026-08-01T00:00:00.000Z"
  });
  const stale = plan("plan-stale", {
    agentType: "codex",
    sessionId: "019fa314-2c07-7523-896f-9bb6b6380999",
    sessionTitle: "旧目录秘书",
    workspace: "C:\\workspace\\other",
    assignedAt: "2026-08-01T00:00:00.000Z"
  });
  const cleared: string[] = [];

  const result = reconcilePlanSecretaryBindingsForWorkspace(
    [retained, stale, plan("plan-unassigned")],
    "C:\\workspace\\route",
    (planId) => cleared.push(planId)
  );

  assert.deepEqual(result, [stale.id]);
  assert.deepEqual(cleared, [stale.id]);
});

test("workspace reconciliation preserves all other target bindings", () => {
  const plans = [undefined, "remote-a", "remote-b"].map((agentTargetId, index) => plan(`scope-${index}`, {
    agentType: "codex", agentTargetId, sessionId: sessions[0]!.threadId,
    workspace: "C:/workspace/old"
  } as PlanItem["secretaryBinding"]));
  const cleared: string[] = [];
  assert.deepEqual(reconcilePlanSecretaryBindingsForWorkspace(plans, "C:/workspace/new", (id) => cleared.push(id), "remote-a"), ["scope-1"]);
  assert.deepEqual(cleared, ["scope-1"]);
  assert.deepEqual(reconcilePlanSecretaryBindingsForWorkspace(plans, "C:/workspace/new", () => {}), ["scope-0"]);
});

test("workspace reconciliation does not clear bindings when the Primary Persona workspace is unknown", () => {
  const bound = plan("plan-bound", {
    agentType: "codex",
    sessionId: sessions[0]!.threadId,
    workspace: "C:\\workspace\\route"
  });
  const cleared: string[] = [];

  assert.deepEqual(
    reconcilePlanSecretaryBindingsForWorkspace([bound], undefined, (planId) => cleared.push(planId)),
    []
  );
  assert.deepEqual(cleared, []);
});

test("DSH plans keep a stable DSH secretary binding", () => {
  const dshSessions = [{
    agentAdapter: "dsh" as const,
    threadId: "session-00000000-0000-4000-8000-000000000021",
    threadName: "DSH 主人格 协助处理计划",
    workspace: "C:\\workspace\\route",
    index: 1
  }];
  const first = resolvePlanSecretaryAssignment(plan("plan-dsh"), dshSessions, "2026-08-20T00:00:00.000Z");
  const second = resolvePlanSecretaryAssignment(plan("plan-dsh", first?.binding), dshSessions, "2026-08-20T01:00:00.000Z");

  assert.equal(first?.target.agentAdapter, "dsh");
  assert.equal(first?.binding.agentType, "dsh");
  assert.equal(second?.target.threadId, first?.target.threadId);
  assert.equal(second?.binding.assignedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(second?.changed, false);
});
test("a legacy Codex-typed binding keeps the same session when that secretary is now DSH", () => {
  const dshSessions = [{
    agentAdapter: "dsh" as const,
    threadId: "session-00000000-0000-4000-8000-000000000022",
    threadName: "DSH 主人格 协助处理计划2",
    workspace: "C:\\workspace\\route",
    index: 2
  }];
  const legacyBinding = {
    agentType: "codex" as const,
    sessionId: dshSessions[0]!.threadId,
    sessionTitle: dshSessions[0]!.threadName,
    workspace: dshSessions[0]!.workspace,
    assignedAt: "2026-08-19T00:00:00.000Z"
  };

  const repaired = resolvePlanSecretaryAssignment(
    plan("plan-dsh-migrated", legacyBinding),
    dshSessions,
    "2026-08-20T00:00:00.000Z"
  );
  const repeated = resolvePlanSecretaryAssignment(
    plan("plan-dsh-migrated", repaired?.binding),
    dshSessions,
    "2026-08-20T01:00:00.000Z"
  );

  assert.equal(repaired?.target.threadId, legacyBinding.sessionId);
  assert.equal(repaired?.binding.agentType, "dsh");
  assert.equal(repaired?.binding.assignedAt, legacyBinding.assignedAt);
  assert.equal(repaired?.changed, true);
  assert.equal(repeated?.target.threadId, legacyBinding.sessionId);
  assert.equal(repeated?.changed, false);
});
