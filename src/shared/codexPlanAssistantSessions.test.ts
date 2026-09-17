import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CODEX_PLAN_ASSISTANT_MODEL,
  filterCodexPlanAssistantSessionsForTarget,
  codexPlanAssistantInitializationPrompt,
  codexPlanAssistantSessionTitles,
  normalizeCodexPlanAssistantSessions,
  resolveCodexPlanAssistantTurnModel
} from "./codexPlanAssistantSessions.js";

test("target pools retain colliding ids and independently cap and index eight sessions", () => {
  const rows = [undefined, "local:codex", "remote-a", "remote-b"].flatMap((agentTargetId) =>
    Array.from({ length: 10 }, (_, index) => ({
      agentTargetId,
      threadId: `019fa314-2c07-7523-896f-${String(index).padStart(12, "0")}`,
      threadName: `Secretary ${index}`,
      workspace: "C:/workspace/example",
      index: 10 - index
    })));
  const result = normalizeCodexPlanAssistantSessions([...rows, rows[0]]);
  assert.equal(result.length, 32);
  for (const target of [undefined, "local:codex", "remote-a", "remote-b"]) {
    const pool = filterCodexPlanAssistantSessionsForTarget(result, target);
    assert.deepEqual(pool.map((row) => row.index), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(pool[0]?.threadId, rows[9]?.threadId);
  }
  assert.deepEqual(normalizeCodexPlanAssistantSessions(result), result);
  assert.equal(filterCodexPlanAssistantSessionsForTarget(result, "missing").length, 0);
  assert.equal(filterCodexPlanAssistantSessionsForTarget(result, " ").length, 8);
});

test("deduplication includes provider and target without guessing legacy ownership", () => {
  const base = { threadId: "019fa314-2c07-7523-896f-9bb6b638054a", threadName: "Secretary", workspace: "C:/workspace/example", index: 1 };
  const result = normalizeCodexPlanAssistantSessions([
    base, { ...base, agentTargetId: " remote-a " },
    { ...base, agentTargetId: "remote-a", agentAdapter: "codex" },
    { ...base, agentTargetId: "remote-a", agentAdapter: "antigravity" },
    { ...base, agentTargetId: "remote-b" }
  ]);
  assert.equal(result.length, 4);
  assert.equal(filterCodexPlanAssistantSessionsForTarget(result).length, 1);
  assert.equal(filterCodexPlanAssistantSessionsForTarget(result, "remote-a").length, 2);
  assert.ok(result.some((row) => row.agentAdapter === "antigravity"));
  assert.equal(resolveCodexPlanAssistantTurnModel(result, base.threadId, undefined, "remote-a"), undefined);
  assert.equal(resolveCodexPlanAssistantTurnModel(result, base.threadId, undefined, "remote-b"), DEFAULT_CODEX_PLAN_ASSISTANT_MODEL);
});

test("one plan assistant uses the unnumbered Chinese suffix", () => {
  assert.deepEqual(codexPlanAssistantSessionTitles("建造师 策划 程序", 1), [
    "建造师 策划 程序 协助处理计划"
  ]);
});

test("multiple plan assistants use stable one-based suffixes", () => {
  assert.deepEqual(codexPlanAssistantSessionTitles("建造师 策划 程序", 3), [
    "建造师 策划 程序 协助处理计划1",
    "建造师 策划 程序 协助处理计划2",
    "建造师 策划 程序 协助处理计划3"
  ]);
});

test("plan assistant bindings keep exact ids and normalize indexes", () => {
  const sessions = normalizeCodexPlanAssistantSessions([
    {
      threadId: "019fa314-2c07-7523-896f-9bb6b638054b",
      threadName: "主任务 协助处理计划2",
      workspace: "C:\\Data\\Project",
      index: 7
    },
    {
      threadId: "019fa314-2c07-7523-896f-9bb6b638054a",
      threadName: "主任务 协助处理计划1",
      workspace: "C:\\Data\\Project",
      index: 1
    }
  ]);

  assert.deepEqual(sessions.map((item) => ({ id: item.threadId, index: item.index })), [
    { id: "019fa314-2c07-7523-896f-9bb6b638054a", index: 1 },
    { id: "019fa314-2c07-7523-896f-9bb6b638054b", index: 2 }
  ]);
  assert.equal(sessions[0]?.model, DEFAULT_CODEX_PLAN_ASSISTANT_MODEL);
});

test("plan assistant turns default to GPT-5.6 Terra without overriding an explicit model", () => {
  const sessions = normalizeCodexPlanAssistantSessions([{
    threadId: "019fa314-2c07-7523-896f-9bb6b638054a",
    threadName: "主任务 协助处理计划",
    workspace: "C:\\Data\\Project",
    index: 1
  }]);

  assert.equal(
    resolveCodexPlanAssistantTurnModel(sessions, sessions[0]?.threadId, undefined),
    "gpt-5.6-terra"
  );
  assert.equal(
    resolveCodexPlanAssistantTurnModel(sessions, sessions[0]?.threadId, "gpt-5.6-sol"),
    "gpt-5.6-sol"
  );
  assert.equal(resolveCodexPlanAssistantTurnModel(sessions, "019f0000-0000-7000-8000-000000000099", undefined), undefined);
});

test("plan assistant initialization keeps the secretary control-only and preserves business task ownership", () => {
  const prompt = codexPlanAssistantInitializationPrompt({
    roleId: "XinghaiBuilder",
    sourceAgentAdapter: "codex",
    assistantAgentAdapter: "codex",
    sourceThreadId: "019fa314-2c07-7523-896f-9bb6b638054c",
    sourceThreadName: "建造师 策划 程序",
    assistantThreadId: "019fa314-2c07-7523-896f-9bb6b638054d",
    assistantThreadName: "建造师 策划 程序 协助处理计划1",
    workspace: "C:\\work\\example",
    managerBaseUrl: "http://127.0.0.1:8790",
    count: 2,
    index: 1
  });

  assert.match(prompt, /\[rabi:bind XinghaiBuilder\]/);
  assert.match(prompt, /持久计划秘书，只管理控制面/);
  assert.match(prompt, /taskBinding 只指向独立业务任务/);
  assert.match(prompt, /secretaryBinding 记录秘书/);
  assert.match(prompt, /不执行调查、代码、资源、构建、发布或外部操作/);
  assert.match(prompt, /同一 planId 只有一个控制面 writer/);
  assert.match(prompt, /不同计划可并行/);
  assert.match(prompt, /taskBinding 状态/);
  assert.match(prompt, /本秘书任务：建造师 策划 程序 协助处理计划1/);
  assert.match(prompt, /sourceThreadId=019fa314-2c07-7523-896f-9bb6b638054d/);
  assert.match(prompt, /sourceAgentType=plan_secretary/);
  assert.match(prompt, /投递到 threadId=.*并取得回执/);
  assert.match(prompt, /本轮执行一项并更新计划与记忆/);
  assert.match(prompt, /消费业务结果、更新计划与记忆并续投/);
  assert.match(prompt, /仅把决定、批准、授权、缺少输入或最终复核升级给主人格/);
  assert.match(prompt, /Idempotency-Key/);
  assert.match(prompt, /If-Match/);
  assert.match(prompt, /强 ETag/);
  assert.match(prompt, /有界超时/);
  assert.match(prompt, /applicationGenerationId/);
  assert.match(prompt, /managerInstanceId/);
  assert.match(prompt, /成功响应.*Idempotency-Key.*强 ETag/);
  assert.match(prompt, /503[^\n]*同一个 Idempotency-Key/);
  assert.match(prompt, /412[^\n]*废弃[^\n]*重新 GET[^\n]*新[^\n]*Idempotency-Key/);
});
