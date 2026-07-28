import assert from "node:assert/strict";
import test from "node:test";
import {
  codexPlanAssistantInitializationPrompt,
  codexPlanAssistantSessionTitles,
  normalizeCodexPlanAssistantSessions
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
});

test("plan assistant initialization keeps the secretary control-only and preserves business task ownership", () => {
  const prompt = codexPlanAssistantInitializationPrompt({
    roleId: "XinghaiBuilder",
    sourceThreadId: "019fa314-2c07-7523-896f-9bb6b638054c",
    sourceThreadName: "建造师 策划 程序",
    workspace: "C:\\Data\\CottonProject\\RabiRoute",
    count: 2,
    index: 1
  });

  assert.match(prompt, /\[rabi:bind XinghaiBuilder\]/);
  assert.match(prompt, /持久计划管理秘书/);
  assert.match(prompt, /属于控制面/);
  assert.match(prompt, /taskBinding 必须始终指向独立业务任务会话/);
  assert.match(prompt, /绝不能保存本秘书会话/);
  assert.match(prompt, /禁止在本秘书会话中执行业务调查/);
  assert.match(prompt, /临时子 Agent/);
  assert.match(prompt, /同样不得执行业务工作/);
  assert.match(prompt, /业务 taskBinding 的真实状态/);
});
