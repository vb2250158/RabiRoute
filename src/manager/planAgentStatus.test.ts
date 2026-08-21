import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import { createPlanAgentStatusService } from "./planAgentStatus.js";

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    title: "Plan",
    focus: "Plan",
    status: "进行中",
    attachments: [],
    steps: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    keywords: [],
    ...overrides
  };
}

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    title: "Plan Agent",
    cwd: "C:\\work",
    archived: false,
    status: { type: "idle" },
    ...overrides
  };
}

test("plan Agent status keeps work state separate from Codex task state", async () => {
  const values = new Map<string, unknown>([
    ["active-thread", thread({ id: "active-thread", status: { type: "active" } })],
    ["idle-thread", thread({ id: "idle-thread", status: { type: "idle" } })],
    ["extended-path-thread", thread({ id: "extended-path-thread", cwd: "\\\\?\\C:\\work", status: { type: "idle" } })],
    ["unavailable-thread", thread({ id: "unavailable-thread", status: { type: "unavailable" } })]
  ]);
  const service = createPlanAgentStatusService({
    readThread: async (threadId) => {
      if (!values.has(threadId)) throw new Error(`Codex Desktop task was not found: ${threadId}`);
      return values.get(threadId);
    },
    now: () => new Date("2026-08-07T10:00:00.000Z")
  });

  const statuses = await service.inspectPlans([
    plan({ id: "active", taskBinding: { agentType: "codex", sessionId: "active-thread", workspace: "C:\\work" } }),
    plan({ id: "idle", taskBinding: { agentType: "codex", sessionId: "idle-thread", workspace: "C:\\work" } }),
    plan({ id: "extended-path", taskBinding: { agentType: "codex", sessionId: "extended-path-thread", workspace: "C:\\work" } }),
    plan({ id: "unavailable", taskBinding: { agentType: "codex", sessionId: "unavailable-thread", workspace: "C:\\work" } }),
    plan({ id: "missing", taskBinding: { agentType: "codex", sessionId: "missing-thread", workspace: "C:\\work" } }),
    plan({ id: "unbound" })
  ]);

  assert.deepEqual(statuses.map((item) => ({
    planId: item.planId,
    working: item.taskAgent.working,
    agentStatus: item.taskAgent.agentStatus,
    sessionStatus: item.taskAgent.sessionStatus
  })), [
    { planId: "active", working: true, agentStatus: "working", sessionStatus: "active" },
    { planId: "idle", working: false, agentStatus: "idle", sessionStatus: "idle" },
    { planId: "extended-path", working: false, agentStatus: "idle", sessionStatus: "idle" },
    { planId: "unavailable", working: false, agentStatus: "unknown", sessionStatus: "unavailable" },
    { planId: "missing", working: false, agentStatus: "unknown", sessionStatus: "missing" },
    { planId: "unbound", working: false, agentStatus: "unknown", sessionStatus: "unbound" }
  ]);
});

test("plan Agent status deduplicates one task used by task and secretary bindings", async () => {
  let reads = 0;
  const service = createPlanAgentStatusService({
    readThread: async () => {
      reads += 1;
      return thread({ status: { type: "active" } });
    }
  });
  const [status] = await service.inspectPlans([plan({
    taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work" },
    secretaryBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work" }
  })]);

  assert.equal(reads, 1);
  assert.equal(status?.taskAgent.role, "task");
  assert.equal(status?.secretaryAgent?.role, "secretary");
  assert.equal(status?.secretaryAgent?.working, true);
});

test("plan Agent status turns timeout and workspace mismatch into non-working diagnostic states", async () => {
  const timeoutService = createPlanAgentStatusService({
    readThread: async () => new Promise(() => undefined),
    timeoutMs: 10
  });
  const [timedOut] = await timeoutService.inspectPlans([plan({
    taskBinding: { agentType: "codex", sessionId: "slow", workspace: "C:\\work" }
  })]);
  assert.equal(timedOut?.taskAgent.working, false);
  assert.equal(timedOut?.taskAgent.sessionStatus, "unknown");

  const mismatchService = createPlanAgentStatusService({
    readThread: async () => thread({ cwd: "D:\\other" })
  });
  const [mismatch] = await mismatchService.inspectPlans([plan({
    taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work" }
  })]);
  assert.equal(mismatch?.taskAgent.sessionStatus, "workspace_mismatch");
  assert.equal(mismatch?.taskAgent.canOpen, false);
});

test("opening a plan Agent only opens the exact verified Codex task", async () => {
  const opened: string[] = [];
  const service = createPlanAgentStatusService({
    readThread: async () => thread(),
    openThread: async (threadId) => { opened.push(threadId); }
  });
  const result = await service.openPlanAgent(plan({
    taskBinding: { agentType: "codex", sessionId: "thread-1", sessionTitle: "Saved title", workspace: "C:\\work" }
  }), "task");

  assert.deepEqual(opened, ["thread-1"]);
  assert.equal(result.opened, true);
  assert.equal(result.threadTitle, "Plan Agent");
});


test("plan Agent status reads and opens the exact DSH session through its bound adapter", async () => {
  const reads: Array<{ sessionId: string; baseUrl?: string }> = [];
  const opened: Array<{ sessionId: string; baseUrl?: string }> = [];
  const service = createPlanAgentStatusService({
    readDshSession: async (sessionId, baseUrl) => {
      reads.push({ sessionId, baseUrl });
      return thread({
        id: sessionId,
        title: "DSH 计划任务",
        cwd: "C:\\work",
        status: { type: "idle" }
      });
    },
    openDshSession: async (sessionId, baseUrl) => { opened.push({ sessionId, baseUrl }); }
  });
  const dshBinding = {
    agentType: "dsh" as const,
    sessionId: "session-00000000-0000-4000-8000-000000000001",
    sessionTitle: "DSH 计划任务",
    workspace: "C:\\work",
    baseUrl: "http://127.0.0.1:3080"
  };
  const [status] = await service.inspectPlans([plan({ taskBinding: dshBinding })]);
  assert.equal(status?.taskAgent.agentType, "dsh");
  assert.equal(status?.taskAgent.sessionStatus, "idle");
  assert.deepEqual(reads, [{ sessionId: dshBinding.sessionId, baseUrl: dshBinding.baseUrl }]);

  const result = await service.openPlanAgent(plan({ taskBinding: dshBinding }), "task");
  assert.equal(result.agentType, "dsh");
  assert.deepEqual(opened, [{ sessionId: dshBinding.sessionId, baseUrl: dshBinding.baseUrl }]);
});
