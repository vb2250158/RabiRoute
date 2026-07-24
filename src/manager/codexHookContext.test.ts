import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexHookContextService,
  parseCodexHookControl,
  type CodexHookContextRequest,
  type PlanTaskCompletionDelivery
} from "./codexHookContext.js";

function fixture(options: {
  deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  hookEnabled?: (request: CodexHookContextRequest) => boolean;
} = {}): { root: string; rolesRoot: string; roleDir: string; storePath: string; service: CodexHookContextService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "YeYu");
  const storePath = path.join(root, "data", "codex-hook", "sessions.json");
  const timestamp = new Date().toISOString();
  fs.mkdirSync(path.join(roleDir, "plans", "items", "active"), { recursive: true });
  fs.mkdirSync(path.join(roleDir, "memory", "recent"), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n温柔、清楚，只根据真实上下文行动。", "utf8");
  fs.writeFileSync(path.join(roleDir, "growth.md"), "# 成长\n\n不确定时承认不确定。", "utf8");
  fs.writeFileSync(path.join(roleDir, "plans", "items", "active", "plan-hook.json"), JSON.stringify({
    id: "plan-hook",
    title: "统一 Codex Hook 上下文",
    focus: "统一 Codex Hook 上下文",
    status: "进行中",
    currentStep: "复用 RabiRoute 管理机制",
    nextAction: "验证 Manager API",
    steps: [],
    taskBinding: {
      agentType: "codex",
      sessionId: "session-plan-worker",
      sessionTitle: "计划执行任务",
      workspace: root,
      completionHook: { enabled: true, gatewayId: "YeYu__reminder" }
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["统一管理"]
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), JSON.stringify({
    id: "memory-hook",
    title: "Hook 只做触发和注入",
    focus: "Hook 只做触发和注入",
    content: "人格、计划和记忆由 Rabi PC 管理。",
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["触发器和注入器"]
  }, null, 2), "utf8");
  return {
    root,
    rolesRoot,
    roleDir,
    storePath,
    service: new CodexHookContextService({
      rolesRoot: () => rolesRoot,
      storePath,
      deliverPlanTaskCompletion: options.deliverPlanTaskCompletion,
      hookEnabled: options.hookEnabled
    })
  };
}

test("Codex hook control markers remain strict", () => {
  assert.deepEqual(parseCodexHookControl("[rabi:use YeYu]"), { action: "bind", roleId: "YeYu" });
  assert.deepEqual(parseCodexHookControl("hello [rabi:refresh]"), { action: "refresh" });
  assert.equal(parseCodexHookControl("please use YeYu"), null);
});

test("an unbound Codex session receives no Rabi context", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({ sessionId: "session-unbound", eventName: "UserPromptSubmit", prompt: "hello" });
  assert.equal(result.binding, null);
  assert.equal(result.additionalContext, "");
});

test("binding and base context are owned by Rabi Manager", (t) => {
  const { root, storePath, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({
    sessionId: "session-yeyu",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]",
    managerBaseUrl: "http://127.0.0.1:8790"
  });
  assert.equal(result.binding?.roleId, "YeYu");
  assert.match(result.additionalContext, /人格、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理/);
  assert.match(result.additionalContext, /温柔、清楚/);
  assert.match(result.additionalContext, /统一 Codex Hook 上下文/);
  assert.ok(fs.existsSync(storePath));
  assert.ok(result.additionalContext.length <= 6200);
});

test("prompt recall uses roleKnowledgeSnapshot and refreshes memory viewedAt", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-recall", "YeYu");
  service.handleContext({ sessionId: "session-recall", eventName: "SessionStart", source: "startup" });
  const result = service.handleContext({
    sessionId: "session-recall",
    eventName: "UserPromptSubmit",
    prompt: "这个 Hook 应该只是触发器和注入器"
  });
  assert.match(result.additionalContext, /memory-hook/);
  assert.match(result.additionalContext, /GET \/api\/roles\/YeYu\/memory\/recent\/memory-hook/);
  assert.doesNotMatch(result.additionalContext, /\[人格工作集\]/);
  const memory = JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8"));
  assert.equal(typeof memory.viewedAt, "string");
});

test("Rabi PC can proactively bind and unbind an exact Codex session", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = service.bindSession("session-direct", "YeYu");
  assert.equal(service.getBinding("session-direct")?.roleId, "YeYu");
  assert.equal(service.listBindings().length, 1);
  assert.equal(service.unbindSession("session-direct")?.sessionId, binding.sessionId);
  assert.equal(service.getBinding("session-direct"), null);
});

test("reasoning hooks inject new keyword matches once per turn", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-reasoning", "YeYu");
  service.handleContext({ sessionId: "session-reasoning", eventName: "SessionStart", source: "startup" });
  service.handleContext({
    sessionId: "session-reasoning",
    eventName: "UserPromptSubmit",
    turnId: "turn-1",
    prompt: "继续处理"
  });
  const pre = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PreToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" }
  });
  assert.match(pre.additionalContext, /Rabi 推理期上下文刷新/);
  assert.match(pre.additionalContext, /memory-hook/);
  const firstViewedAt = JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8")).viewedAt;
  const duplicatePost = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" },
    toolResponse: "触发器和注入器"
  });
  assert.equal(duplicatePost.additionalContext, "");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8")).viewedAt,
    firstViewedAt
  );
  const nextTurn = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-2",
    toolName: "Bash",
    toolUseId: "tool-2",
    toolResponse: "触发器和注入器"
  });
  assert.match(nextTurn.additionalContext, /memory-hook/);
});

test("irrelevant reasoning hooks remain silent", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-quiet", "YeYu");
  service.handleContext({ sessionId: "session-quiet", eventName: "SessionStart" });
  const result = service.handleContext({
    sessionId: "session-quiet",
    eventName: "PreToolUse",
    turnId: "turn-quiet",
    toolName: "Bash",
    toolInput: { command: "npm test" }
  });
  assert.equal(result.additionalContext, "");
});

test("disabled Codex endpoint hooks stay silent and do not deliver completion reminders", async (t) => {
  let deliveryCount = 0;
  const { root, service } = fixture({
    hookEnabled: () => false,
    deliverPlanTaskCompletion: async () => { deliveryCount += 1; }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");

  const context = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:refresh]"
  });
  assert.equal(context.additionalContext, "");
  const completion = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-disabled",
    cwd: root,
    lastAssistantMessage: "不应投递。"
  });
  assert.equal(completion.planTaskCompletion?.status, "ignored");
  assert.equal(completion.planTaskCompletion?.reason, "hook_disabled_by_codex_endpoint");
  assert.equal(deliveryCount, 0);
});

test("Stop hooks deliver a bound plan task final message once through Manager", async (t) => {
  const deliveries: PlanTaskCompletionDelivery[] = [];
  const { root, storePath, service } = fixture({
    deliverPlanTaskCompletion: async (delivery) => {
      deliveries.push(delivery);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-1",
    cwd: root,
    lastAssistantMessage: "实现完成，测试通过。"
  });
  assert.equal(first.binding, null);
  assert.equal(first.additionalContext, "");
  assert.equal(first.planTaskCompletion?.status, "delivered");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.plan.id, "plan-hook");
  assert.equal(deliveries[0]?.gatewayId, "YeYu__reminder");
  assert.equal(deliveries[0]?.finalMessage, "实现完成，测试通过。");

  const duplicate = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-1",
    cwd: root,
    lastAssistantMessage: "实现完成，测试通过。"
  });
  assert.equal(duplicate.planTaskCompletion?.status, "duplicate");
  assert.equal(deliveries.length, 1);
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(Object.values(store.planTaskCompletions).some((state: any) => (
    state.sessionId === "session-plan-worker"
    && state.turnId === "turn-plan-1"
    && state.status === "delivered"
  )), true);
});

test("Stop hook deduplication survives later turns in the same session", async (t) => {
  const deliveries: PlanTaskCompletionDelivery[] = [];
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async (delivery) => {
      deliveries.push(delivery);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const turnId of ["turn-plan-1", "turn-plan-2", "turn-plan-1"]) {
    await service.handleHook({
      sessionId: "session-plan-worker",
      eventName: "Stop",
      turnId,
      cwd: root,
      lastAssistantMessage: `final ${turnId}`
    });
  }

  assert.deepEqual(deliveries.map((item) => item.sourceTurnId), ["turn-plan-1", "turn-plan-2"]);
});

test("Stop hooks fail closed on a plan task workspace mismatch", async (t) => {
  let called = false;
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {
      called = true;
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-mismatch",
    cwd: path.join(root, "other-project"),
    lastAssistantMessage: "不应投递。"
  });
  assert.equal(result.planTaskCompletion?.status, "failed");
  assert.equal(result.planTaskCompletion?.reason, "workspace_mismatch");
  assert.equal(called, false);
});

test("Stop hook delivery failures are recorded without blocking the Codex turn", async (t) => {
  const { root, service } = fixture({
    deliverPlanTaskCompletion: async () => {
      throw new Error("reminder gateway offline");
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-plan-worker", "YeYu");
  const result = await service.handleHook({
    sessionId: "session-plan-worker",
    eventName: "Stop",
    turnId: "turn-plan-failed",
    cwd: root,
    lastAssistantMessage: "阶段结果已经生成。"
  });
  assert.equal(result.additionalContext, "");
  assert.equal(result.planTaskCompletion?.status, "failed");
  assert.match(result.planTaskCompletion?.error || "", /reminder gateway offline/);
  const binding = service.getBinding("session-plan-worker");
  assert.equal(binding?.lastPlanCompletionStatus, "failed");
  assert.match(binding?.lastPlanCompletionError || "", /reminder gateway offline/);
});
