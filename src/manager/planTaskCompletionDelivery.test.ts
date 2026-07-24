import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRolePanelTimeline } from "../rolePanelTimeline.js";
import type { PlanItem } from "../roleKnowledge.js";
import {
  createPlanTaskCompletionDelivery,
  type PlanTaskCompletionRuntime
} from "./planTaskCompletionDelivery.js";

type Runtime = PlanTaskCompletionRuntime;

function runtime(id: string, roleId: string, codexThreadId = `target-${id}`): Runtime {
  return {
    definition: {
      id,
      agentRoleId: roleId,
      agentAdapters: ["codex"],
      codexThreadId,
      routeProfiles: [{ id: `${id}-profile` }]
    }
  };
}

function plan(gatewayId?: string): PlanItem {
  return {
    id: "plan-hook",
    title: "计划任务完成提醒",
    focus: "计划任务完成提醒",
    status: "进行中",
    steps: [{ id: "run", title: "执行任务", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "source-session",
      completionHook: { enabled: true, gatewayId }
    },
    keywords: ["计划"],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

function delivery(roleDir: string, gatewayId?: string) {
  return {
    roleId: "YeYu",
    roleDir,
    plan: plan(gatewayId),
    sourceSessionId: "source-session",
    sourceTurnId: "turn-1",
    sourceCwd: "C:\\workspace\\project",
    finalMessage: "实现完成，测试通过。",
    gatewayId
  };
}

test("plan task completion writes the RolePanel timeline and invokes the selected route handoff", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-delivery-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const selected = runtime("YeYu__reminder", "YeYu");
  const handoffs: Array<{ runtimeId: string; messageId: string; text: string }> = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const deliver = createPlanTaskCompletionDelivery({
    getRuntime: (id) => id === selected.definition.id ? selected : undefined,
    listRuntimes: () => [selected],
    roleIdForDefinition: (definition) => definition.agentRoleId || "",
    triggerRolePanelMessage: async (target, messageId, text) => {
      handoffs.push({ runtimeId: target.definition.id, messageId, text });
    },
    publishEvent: (type, data) => events.push({ type, data })
  });

  await deliver(delivery(roleDir, selected.definition.id));

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].runtimeId, selected.definition.id);
  assert.match(handoffs[0].messageId, /^plan-task-completed-[a-f0-9]{24}$/);
  assert.match(handoffs[0].text, /实现完成，测试通过/);
  const timeline = readRolePanelTimeline(roleDir);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].id, handoffs[0].messageId);
  assert.equal(timeline[0].replyContext?.targetType, "plan_task_completion");
  assert.equal(events[0].type, "plan_task_completed");
  assert.equal(events[0].data.gatewayId, selected.definition.id);
});

test("plan task completion fails closed for missing or conflicting route bindings", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-delivery-errors-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const roleRoute = runtime("YeYu__one", "YeYu");
  const secondRoleRoute = runtime("YeYu__two", "YeYu");
  const missingTaskRoute = runtime("YeYu__missing-task", "YeYu", "");
  const otherRoleRoute = runtime("Other__main", "Other");
  const runtimes = [roleRoute, secondRoleRoute, missingTaskRoute, otherRoleRoute];
  let handoffCount = 0;
  const deliver = createPlanTaskCompletionDelivery({
    getRuntime: (id) => runtimes.find((item) => item.definition.id === id),
    listRuntimes: () => runtimes,
    roleIdForDefinition: (definition) => definition.agentRoleId || "",
    triggerRolePanelMessage: async () => { handoffCount += 1; }
  });

  await assert.rejects(deliver(delivery(roleDir, "missing")), /Gateway not found/);
  await assert.rejects(deliver(delivery(roleDir, otherRoleRoute.definition.id)), /not bound to role YeYu/);
  await assert.rejects(deliver(delivery(roleDir, missingTaskRoute.definition.id)), /has no bound Codex Desktop task/);
  await assert.rejects(deliver(delivery(roleDir)), /Multiple gateways are bound to role YeYu/);
  assert.equal(handoffCount, 0);
  assert.equal(readRolePanelTimeline(roleDir).length, 0);
});

test("plan task completion rejects a Codex target bound to the source session", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-delivery-loop-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const selected = runtime("YeYu__same", "YeYu", "source-session");
  let handoffCount = 0;
  const deliver = createPlanTaskCompletionDelivery({
    getRuntime: () => selected,
    listRuntimes: () => [selected],
    roleIdForDefinition: (definition) => definition.agentRoleId || "",
    triggerRolePanelMessage: async () => { handoffCount += 1; }
  });

  await assert.rejects(
    deliver(delivery(roleDir, selected.definition.id)),
    /must differ from the completed task session/
  );
  assert.equal(handoffCount, 0);
  assert.equal(readRolePanelTimeline(roleDir).length, 0);
});

test("plan task completion respects the target Codex endpoint Hook switch", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-delivery-disabled-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const selected = runtime("YeYu__disabled", "YeYu");
  selected.definition.codexHooks = {
    sessionContextEnabled: true,
    reasoningContextEnabled: true,
    planTaskCompletionEnabled: false
  };
  let handoffCount = 0;
  const deliver = createPlanTaskCompletionDelivery({
    getRuntime: () => selected,
    listRuntimes: () => [selected],
    roleIdForDefinition: (definition) => definition.agentRoleId || "",
    triggerRolePanelMessage: async () => { handoffCount += 1; }
  });

  await assert.rejects(
    deliver(delivery(roleDir, selected.definition.id)),
    /disabled plan task completion notifications/
  );
  assert.equal(handoffCount, 0);
  assert.equal(readRolePanelTimeline(roleDir).length, 0);
});
