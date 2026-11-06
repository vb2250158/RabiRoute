import assert from "node:assert/strict";
import test from "node:test";
import type { PlanHistoryRecord, PlanItem } from "../roleKnowledge.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import { createPlanAgentStatusService, type PlanAgentInstanceRequest } from "./planAgentStatus.js";

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    title: "Plan",
    focus: "Plan",
    status: "执行中",
    attachments: [],
    steps: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    keywords: [],
    ...overrides,
    archiveStatus: overrides.archiveStatus ?? "未归档"
  };
}

test("history navigation uses original actor, rejects missing/archived/mismatched sessions and never opens current binding", async () => {
  const record: PlanHistoryRecord = { id: "history-1", planId: "plan-1", kind: "updated", recordedAt: "2026-08-07T00:00:00Z", after: plan({ taskBinding: { agentType: "codex", sessionId: "other" } }), actor: { kind: "agent", agentType: "dsh", sessionId: "original", displayName: "Original", workspace: "old-workspace" } };
  const opened: string[] = [];
  let value: unknown = thread({ id: "original", cwd: "new-workspace" });
  const service = createPlanAgentStatusService({ readDshSession: async () => value, openDshSession: async id => { opened.push(id); } });
  await service.openHistoryActor!(record);
  assert.deepEqual(opened, ["original"]);
  value = thread({ id: "other" });
  await assert.rejects(service.openHistoryActor!(record), /not found/);
  value = thread({ id: "original", archived: true });
  await assert.rejects(service.openHistoryActor!(record), /archived/);
  value = null;
  await assert.rejects(service.openHistoryActor!(record), /not found/);
  await assert.rejects(service.openHistoryActor!({ ...record, actor: { kind: "unknown" } }), /no Agent/);
  assert.deepEqual(opened, ["original"]);
});

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

test("plan Agent status keeps read failures separate and uses the plan workspace for an exact task", async () => {
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
  assert.equal(mismatch?.taskAgent.workspace, "C:\\work");
  assert.equal(mismatch?.taskAgent.canOpen, false);

  const matchingService = createPlanAgentStatusService({
    readThread: async () => thread({ cwd: "C:\\work" })
  });
  const [matching] = await matchingService.inspectPlans([plan({
    taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work" }
  })]);
  assert.equal(matching?.taskAgent.sessionStatus, "idle");
  assert.equal(matching?.taskAgent.workspace, "C:\\work");
  assert.equal(matching?.taskAgent.canOpen, true);
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

test("DSH plan statuses share one complete session catalog per host", async () => {
  const reads: string[] = [];
  const service = createPlanAgentStatusService({
    listDshSessions: async baseUrl => {
      reads.push(baseUrl || "");
      return [
        thread({ id: "session-idle", status: { type: "idle" } }),
        thread({ id: "session-active", status: { type: "active" } })
      ];
    }
  });
  const binding = (sessionId: string) => ({ agentType: "dsh" as const, sessionId, workspace: "C:\\work", baseUrl: "http://127.0.0.1:3180" });
  const statuses = await service.inspectPlans([
    plan({ id: "idle", taskBinding: binding("session-idle") }),
    plan({ id: "active", taskBinding: binding("session-active") }),
    plan({ id: "missing", taskBinding: binding("session-missing") })
  ]);
  assert.deepEqual(reads, ["http://127.0.0.1:3180"]);
  assert.deepEqual(statuses.map(item => item.taskAgent.sessionStatus), ["idle", "active", "missing"]);
});

test("remote plan status isolates the same session by instance, agent and peer owner while retaining local batching", async () => {
  let localReads = 0;
  const remoteReads: PlanAgentInstanceRequest[] = [];
  const first = { instanceId: "pc-a", agentId: "codex-a" };
  const second = { instanceId: "pc-b", agentId: "codex-a" };
  const peer = { ...first, ownerDeviceId: "peer-a" };
  const otherAgent = { ...first, agentId: "codex-b" };
  const remotePlan = (id: string, instanceBinding: AgentInstanceBinding) => plan({ id, taskBinding: {
    agentType: "codex", sessionId: "thread-1", workspace: "C:\\work", instanceBinding
  } });
  const service = createPlanAgentStatusService({
    readThread: async () => { localReads += 1; return thread(); },
    readInstanceThread: async request => {
      remoteReads.push(request);
      return thread({ status: { type: request.instanceBinding.instanceId === "pc-a" ? "active" : "idle" } });
    }
  });
  const statuses = await service.inspectPlans([
    plan({ id: "local", taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work" } }),
    remotePlan("first", first), remotePlan("first-again", first), remotePlan("second", second),
    remotePlan("peer", peer), remotePlan("other-agent", otherAgent)
  ]);
  assert.equal(localReads, 1);
  assert.deepEqual(remoteReads.map(r => r.instanceBinding), [first, second, peer, otherAgent]);
  assert.deepEqual(statuses.map(s => s.taskAgent.sessionStatus), ["idle", "active", "active", "idle", "active", "active"]);
  assert.deepEqual(statuses.map(s => s.taskAgent.instanceBinding), [undefined, first, first, second, peer, otherAgent]);
});

test("remote DSH plans bypass the local DSH session catalog and navigate the exact recorded owner", async () => {
  let catalogReads = 0;
  const opened: PlanAgentInstanceRequest[] = [];
  const remote = { instanceId: "pc-a", agentId: "dsh-a", ownerDeviceId: "peer-a" };
  const service = createPlanAgentStatusService({
    listDshSessions: async () => { catalogReads += 1; return [thread()]; },
    readInstanceThread: async request => thread({ id: request.threadId }),
    openInstanceThread: async request => { opened.push(request); },
    openDshSession: async () => { throw new Error("must not open the local DSH owner"); }
  });
  const p = plan({ taskBinding: { agentType: "dsh", sessionId: "thread-1", workspace: "C:\\work", instanceBinding: remote } });
  const [status] = await service.inspectPlans([p]);
  assert.equal(catalogReads, 0);
  assert.equal(status.taskAgent.sessionStatus, "idle");
  const result = await service.openPlanAgent(p, "task");
  assert.deepEqual(opened, [{ agentAdapter: "dsh", threadId: "thread-1", instanceBinding: remote }]);
  assert.deepEqual(result.instanceBinding, remote);
});

test("missing or failing remote status and navigation never fall back to a local task", async () => {
  let localReads = 0;
  let localOpens = 0;
  const p = plan({ taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work",
    instanceBinding: { instanceId: "pc-a", agentId: "codex-a" } } });
  const local = {
    readThread: async () => { localReads += 1; return thread(); },
    openThread: async () => { localOpens += 1; }
  };
  const missing = createPlanAgentStatusService(local);
  const [status] = await missing.inspectPlans([p]);
  assert.equal(status.taskAgent.canOpen, false);
  assert.match(status.taskAgent.message!, /Remote plan Agent status reader is unavailable/);
  await assert.rejects(missing.openPlanAgent(p, "task"), /Remote plan Agent status reader is unavailable/);
  const navigationMissing = createPlanAgentStatusService({ ...local, readInstanceThread: async () => thread() });
  await assert.rejects(navigationMissing.openPlanAgent(p, "task"), /Remote plan Agent navigation is unavailable/);
  const failing = createPlanAgentStatusService({ ...local, readInstanceThread: async () => { throw new Error("original remote owner offline"); } });
  const [failure] = await failing.inspectPlans([p]);
  assert.match(failure.taskAgent.message!, /original remote owner offline/);
  assert.equal(failure.taskAgent.instanceBinding?.instanceId, "pc-a");
  assert.equal(localReads, 0);
  assert.equal(localOpens, 0);
});

test("status and navigation reject a different session returned by the selected owner", async () => {
  const opens: PlanAgentInstanceRequest[] = [];
  const p = plan({ taskBinding: { agentType: "codex", sessionId: "thread-1", workspace: "C:\\work",
    instanceBinding: { instanceId: "pc-a", agentId: "codex-a" } } });
  const service = createPlanAgentStatusService({
    readInstanceThread: async () => thread({ id: "different-thread" }),
    openInstanceThread: async request => { opens.push(request); }
  });
  const [status] = await service.inspectPlans([p]);
  assert.equal(status.taskAgent.canOpen, false);
  assert.match(status.taskAgent.message!, /identity does not match/);
  await assert.rejects(service.openPlanAgent(p, "task"), /identity does not match/);
  assert.deepEqual(opens, []);
});

test("history navigation preserves recorded remote coordinates instead of borrowing the current binding", async () => {
  const historical = { instanceId: "pc-history", agentId: "codex-history", ownerDeviceId: "peer-history" };
  const current = { instanceId: "pc-current", agentId: "codex-current" };
  const actor = { kind: "agent" as const, agentType: "codex", sessionId: "original", workspace: "C:\\work", instanceBinding: historical };
  const record: PlanHistoryRecord = { id: "remote-history", planId: "plan-1", kind: "updated", recordedAt: "2026-08-07T00:00:00Z",
    after: plan({ taskBinding: { agentType: "codex", sessionId: "original", workspace: "C:\\work", instanceBinding: current } }), actor };
  const read: PlanAgentInstanceRequest[] = [];
  const opened: PlanAgentInstanceRequest[] = [];
  const service = createPlanAgentStatusService({
    readInstanceThread: async request => { read.push(request); return thread({ id: request.threadId }); },
    openInstanceThread: async request => { opened.push(request); },
    readThread: async () => { throw new Error("must not query local history owner"); }
  });
  const result = await service.openHistoryActor!(record);
  assert.deepEqual(read, [{ agentAdapter: "codex", threadId: "original", instanceBinding: historical }]);
  assert.deepEqual(opened, read);
  assert.deepEqual(result.instanceBinding, historical);
});
