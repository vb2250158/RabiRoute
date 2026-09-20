import assert from "node:assert/strict";
import test from "node:test";
import {
  voiceIdentityReviewCapabilityHint,
  needsPlanAssistantHint,
  needsRemoteAgentHint
} from "./agentCapabilityHints.js";

const context = { managerPort: "9000", roleId: "Rabi A" };

test("operation tutorials are selected by current intent instead of installed capabilities", () => {
  for (const text of ["你好", "这个按钮再向下挪一点", "今天吃什么"]) {
    assert.equal(needsPlanAssistantHint(text, "group_message"), false);
    assert.equal(needsRemoteAgentHint(text), false);
  }
  assert.equal(needsPlanAssistantHint("推进计划", "manual_trigger"), true);
  assert.equal(needsPlanAssistantHint("可以", "plan_feedback"), true);
  assert.equal(needsRemoteAgentHint("请在另一台电脑执行构建"), true);
  assert.equal(needsRemoteAgentHint("dispatch a remote agent task"), true);
});

test("voice identity review capability exposes persona-owned daily classification without host identity", () => {
  const hint = voiceIdentityReviewCapabilityHint("今天哪些录音是我说的，哪些是别人说的？", context);
  assert.ok(hint);
  const text = hint.join("\n");
  assert.match(text, /roles\/Rabi%20A\/voice-transcripts/);
  assert.match(text, /speaker=<user\|other\|unknown\|conflict>/);
  assert.match(text, /roles\/Rabi%20A\/voice-identities/);
  assert.match(text, /证据不足时保持 unknown/);
  assert.match(text, /不周期轮询覆盖率/);
  assert.equal(voiceIdentityReviewCapabilityHint("播放下一条语音", context), null);
});

test("capability hints fail closed without a valid current Manager port", () => {
  for (const managerPort of [undefined, "", "0", "65536", "not-a-port", "9000.5"]) {
    assert.throws(
      () => voiceIdentityReviewCapabilityHint("今天哪些录音是我说的？", { managerPort, roleId: "Rabi" }),
      /valid current Manager port/
    );
  }
  assert.throws(
    () => voiceIdentityReviewCapabilityHint("今天哪些录音是我说的？", { roleId: "Rabi" }),
    /valid current Manager port/
  );
});
