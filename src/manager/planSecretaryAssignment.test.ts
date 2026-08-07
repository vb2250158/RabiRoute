import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import type { CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import { resolvePlanSecretaryAssignment } from "./planSecretaryAssignment.js";

function plan(id: string, secretaryBinding?: PlanItem["secretaryBinding"]): PlanItem {
  return {
    id,
    title: id,
    focus: id,
    status: "进行中",
    attachments: [],
    steps: [{ id: "run", title: "执行", status: "进行中" }],
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
