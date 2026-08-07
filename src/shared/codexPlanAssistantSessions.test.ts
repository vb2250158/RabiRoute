import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CODEX_PLAN_ASSISTANT_MODEL,
  codexPlanAssistantInitializationPrompt,
  codexPlanAssistantSessionTitles,
  normalizeCodexPlanAssistantSessions,
  resolveCodexPlanAssistantTurnModel
} from "./codexPlanAssistantSessions.js";

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
    sourceThreadId: "019fa314-2c07-7523-896f-9bb6b638054c",
    sourceThreadName: "建造师 策划 程序",
    assistantThreadId: "019fa314-2c07-7523-896f-9bb6b638054d",
    assistantThreadName: "建造师 策划 程序 协助处理计划1",
    workspace: "C:\\Data\\CottonProject\\RabiRoute",
    count: 2,
    index: 1
  });

  assert.match(prompt, /\[rabi:bind XinghaiBuilder\]/);
  assert.match(prompt, /持久计划管理秘书/);
  assert.match(prompt, /属于控制面/);
  assert.match(prompt, /taskBinding 必须始终指向独立业务任务会话/);
  assert.match(prompt, /secretaryBinding 记录当前负责秘书/);
  assert.match(prompt, /绝不能保存本秘书会话/);
  assert.match(prompt, /禁止在本秘书会话中执行业务调查/);
  assert.match(prompt, /临时子 Agent/);
  assert.match(prompt, /同一 planId 同时只有一个控制面 writer/);
  assert.match(prompt, /不同计划可以并行/);
  assert.match(prompt, /active cycle 不得阻塞其它计划/);
  assert.match(prompt, /同样不得执行业务工作/);
  assert.match(prompt, /业务 taskBinding 的真实状态/);
  assert.match(prompt, /本秘书任务：建造师 策划 程序 协助处理计划1/);
  assert.match(prompt, /sourceThreadId=019fa314-2c07-7523-896f-9bb6b638054d/);
  assert.match(prompt, /sourceAgentType=plan_secretary/);
  assert.match(prompt, /本秘书任务的 Codex 最终输出只供内部查看/);
  assert.match(prompt, /必须实际调用 Manager 线程桥回传/);
  assert.match(prompt, /不得把待确认问题只留在最终输出/);
  assert.match(prompt, /不要只复述、只说已收到或停在状态说明/);
  assert.match(prompt, /必须在本轮采取其中一项/);
  assert.match(prompt, /业务任务完成提醒、计划进展和状态变化默认先回到负责秘书/);
  assert.match(prompt, /普通进展不转给主人格/);
  assert.match(prompt, /计划完整收尾/);
});
