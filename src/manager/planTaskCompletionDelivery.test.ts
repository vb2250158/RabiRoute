import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRolePanelTimeline } from "../rolePanelTimeline.js";
import type { PlanItem } from "../roleKnowledge.js";
import {
  createPlanTaskCompletionDelivery,
  planTaskCompletionAgentText,
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
    attachments: [],
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
  assert.equal(events[0].data.recipient, "persona_fallback");
});

test("enabled plan secretary receives the business result directly without waking the persona", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-delivery-secretary-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const selected = runtime("YeYu__reminder", "YeYu");
  selected.definition.codexPlanAssistantEnabled = true;
  selected.definition.codexPlanAssistantSessions = [{
    threadId: "019f0000-0000-7000-8000-000000000091",
    threadName: "夜雨 协助处理计划1",
    workspace: "C:\\workspace\\route",
    index: 1
  }];
  let personaHandoffs = 0;
  const secretaryHandoffs: Array<{ threadId: string; prompt: string; sourceSessionId: string }> = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const deliver = createPlanTaskCompletionDelivery({
    getRuntime: () => selected,
    listRuntimes: () => [selected],
    roleIdForDefinition: (definition) => definition.agentRoleId || "",
    triggerRolePanelMessage: async () => { personaHandoffs += 1; },
    sendToSecretary: async (_runtime, target, completion, prompt) => {
      secretaryHandoffs.push({
        threadId: target.threadId,
        prompt,
        sourceSessionId: completion.sourceSessionId
      });
    },
    publishEvent: (type, data) => events.push({ type, data })
  });

  await deliver(delivery(roleDir, selected.definition.id));

  assert.equal(personaHandoffs, 0);
  assert.equal(readRolePanelTimeline(roleDir).length, 0);
  assert.equal(secretaryHandoffs.length, 1);
  assert.equal(secretaryHandoffs[0]?.sourceSessionId, "source-session");
  assert.match(secretaryHandoffs[0]?.prompt || "", /结果已直达计划秘书/);
  assert.match(secretaryHandoffs[0]?.prompt || "", /仅把决定、批准、授权、缺少输入或计划最终复核升级给主人格/);
  assert.equal(events[0]?.data.recipient, "secretary");
  assert.equal(events[0]?.data.secretaryThreadId, selected.definition.codexPlanAssistantSessions[0]?.threadId);
});

test("plan task completion reminder keeps the secretary control-only and continues the business task", () => {
  const text = planTaskCompletionAgentText(delivery("C:\\role"));

  assert.match(text, /结果已直达计划秘书/);
  assert.match(text, /^\[投递源\]/);
  assert.match(text, /Agent 端：codex/);
  assert.match(text, /来源会话 ID：source-session/);
  assert.match(text, /来源 Agent：计划执行 Agent/);
  assert.match(text, /来源会话 ID：source-session/);
  assert.match(text, /\[投递内容\]/);
  assert.match(text, /本轮完成以下事项/);
  assert.match(text, /POST \/api\/agent\/threads/);
  assert.match(text, /sourceThreadId=当前秘书会话 ID/);
  assert.match(text, /续投原业务任务 source-session/);
  assert.match(text, /原业务任务/);
  assert.match(text, /taskBinding 只指向业务任务/);
  assert.match(text, /不执行调查、代码、构建、发布或外部操作/);
  assert.match(text, /PangHu 正式 Main 的 Editor 占用/);
  assert.match(text, /静态资源\/序列化合同、非 Unity runner、CLI/);
  assert.match(text, /不得停止 Editor 或取消他人测试/);
  assert.match(text, /可推进计划均有人管理/);
  assert.match(text, /空闲业务任务已续投/);
  assert.match(text, /运行中的任务未重复投递/);
  assert.match(text, /仅把决定、批准、授权、缺少输入或计划最终复核升级给主人格/);
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
    planTaskCompletionEnabled: false,
    agentCommunicationEnforcementEnabled: true
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
