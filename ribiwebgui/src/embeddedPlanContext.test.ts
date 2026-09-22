import assert from "node:assert/strict";
import test from "node:test";
import { embeddedPlanHost, visiblePlanAgentRoles } from "./embeddedPlanContext";

test("仅排除相同处理端和会话，保留其他绑定", () => {
  const host = embeddedPlanHost(true, "dsh", "session-self");
  assert.deepEqual(visiblePlanAgentRoles({ taskBinding: { agentType: "dsh", sessionId: "session-self" }, secretaryBinding: { agentType: "dsh", sessionId: "session-other" } }, host), ["secretary"]);
  assert.deepEqual(visiblePlanAgentRoles({ taskBinding: { agentType: "codex", sessionId: "session-self" } }, host), ["task"]);
  assert.deepEqual(visiblePlanAgentRoles({ taskBinding: { agentType: "dsh", sessionId: "session-self" } }, host), []);
  assert.deepEqual(visiblePlanAgentRoles({}, host), []);
});

test("独立页面和不完整上下文不会隐藏已绑定会话", () => {
  for (const host of [embeddedPlanHost(false, "dsh", "session-self"), embeddedPlanHost(true, "dsh", ""), embeddedPlanHost(true, "other", "session-self")]) {
    assert.equal(host, undefined);
    assert.deepEqual(visiblePlanAgentRoles({ taskBinding: { agentType: "dsh", sessionId: "session-self" } }, host), ["task"]);
  }
});
