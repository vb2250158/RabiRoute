import assert from "node:assert/strict";
import test from "node:test";
import { planMemoryApiHint } from "./roleKnowledgeContext.js";

test("AgentPacket plan hints explain the shared approval feedback workflow", () => {
  const hints = planMemoryApiHint("Rabi Test").join("\n");

  assert.match(hints, /\/api\/roles\/Rabi%20Test\/plans\/\{planId\}\/feedback/);
  assert.match(hints, /source=qq/);
  assert.match(hints, /kind=approval_response/);
  assert.match(hints, /不直接推进步骤/);
  assert.match(hints, /另行 PATCH/);
  assert.match(hints, /approvalRequest/);
  assert.match(hints, /files\/commands\/changes/);
  assert.match(hints, /完整命令/);
  assert.match(hints, /不得用门禁限制用户/);
  assert.match(hints, /根据意见补充/);
  assert.match(hints, /status=暂停/);
  assert.match(hints, /currentStepId/);
});
