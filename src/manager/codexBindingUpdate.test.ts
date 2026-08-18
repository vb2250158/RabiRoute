import assert from "node:assert/strict";
import test from "node:test";
import { resolveReportedCodexBindingUpdate } from "./codexBindingUpdate.js";

test("a delivered replacement updates the exact archived Primary Persona binding", () => {
  const previousThreadId = "019f0000-0000-7000-8000-000000000109";
  const threadId = "019f0000-0000-7000-8000-000000000110";
  assert.deepEqual(resolveReportedCodexBindingUpdate({
    codexThreadId: previousThreadId,
    codexCwd: "C:\\Data\\CottonProject\\RabiRoute"
  }, {
    bindingUpdateRequestedAt: "2026-08-18T02:00:00.000Z",
    bindingPreviousThreadId: previousThreadId,
    bindingThreadId: threadId,
    bindingThreadName: "星海主任务",
    bindingWorkspace: "c:\\data\\cottonproject\\rabiroute"
  }), {
    threadId,
    threadName: "星海主任务",
    workspace: "c:\\data\\cottonproject\\rabiroute"
  });
});

test("a stale or cross-workspace binding update is ignored", () => {
  const threadId = "019f0000-0000-7000-8000-000000000111";
  const state = {
    bindingUpdateRequestedAt: "2026-08-18T02:00:00.000Z",
    bindingPreviousThreadId: "019f0000-0000-7000-8000-000000000112",
    bindingThreadId: threadId,
    bindingWorkspace: "C:\\other"
  };
  assert.equal(resolveReportedCodexBindingUpdate({
    codexThreadId: "019f0000-0000-7000-8000-000000000113",
    codexCwd: "C:\\Data\\CottonProject\\RabiRoute"
  }, state), null);
});
