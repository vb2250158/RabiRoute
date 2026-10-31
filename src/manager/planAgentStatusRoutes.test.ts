import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import type { PlanAgentStatusService } from "./planAgentStatus.js";
import { createPlanAgentStatusOwner } from "./planAgentStatusRoutes.js";

function plan(id: string): PlanItem {
  return {
    id,
    title: id,
    focus: id,
    status: "执行中",
    archiveStatus: "未归档",
    attachments: [],
    steps: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    keywords: []
  };
}

test("history open resolves only the server-owned record and rejects missing history", async () => {
  const opened: string[] = [];
  for (const historyId of ["saved", "missing"]) {
    const owner = createPlanAgentStatusOwner({
      roleDir: () => "role-dir", getPlan: () => plan("plan-1"),
      listPlanHistory: () => [{ id: "saved", planId: "plan-1", kind: "updated", recordedAt: "2026-08-07T00:00:00Z", after: plan("plan-1"), actor: { kind: "agent", agentType: "dsh", sessionId: "original" } }],
      service: { inspectPlans: async () => [], openPlanAgent: async () => { throw new Error("must not use current binding"); },
        openHistoryActor: async record => { opened.push(record.actor!.sessionId!); return { opened: true, agentType: "dsh", threadId: "original", threadTitle: "Original", workspace: "" }; }
      }
    });
    const prepared = owner.prepare({ headers: {} } as http.IncomingMessage, 'Rabi');
    const action = prepared.open('plan-1', { historyId, actor: { sessionId: 'forged' } });
    if (historyId === 'saved') assert.equal((await action).threadId, 'original');
    else await assert.rejects(action, (error: any) => error.statusCode === 404);
  }
  assert.deepEqual(opened, ["original"]);
});

test("plan Agent status route batches only requested plan ids", async () => {
  const inspected: string[][] = [];
  const service: PlanAgentStatusService = {
    inspectPlans: async (plans) => {
      inspected.push(plans.map((item) => item.id));
      return plans.map((item) => ({
        planId: item.id,
        checkedAt: "2026-08-07T00:00:00.000Z",
        taskAgent: {
          role: "task",
          configured: false,
          agentType: "codex",
          threadId: "",
          threadTitle: "",
          workspace: "",
          working: false,
          agentStatus: "unknown",
          sessionStatus: "unbound",
          canOpen: false,
          checkedAt: "2026-08-07T00:00:00.000Z"
        }
      }));
    },
    openPlanAgent: async () => { throw new Error("not used"); }
  };
  const owner = createPlanAgentStatusOwner({
      roleDir: () => "role-dir",
      listPlans: () => [plan("plan-1"), plan("plan-2")],
      service
  });
  const data = await owner.prepare({ headers: {} } as http.IncomingMessage, 'Rabi').inspect(['plan-2','missing']);
  assert.deepEqual(inspected, [["plan-2"]]);
  assert.deepEqual(data.missingPlanIds, ["missing"]);
});
