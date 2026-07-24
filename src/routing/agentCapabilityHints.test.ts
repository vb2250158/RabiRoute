import assert from "node:assert/strict";
import test from "node:test";
import {
  personaSyncCapabilityHint,
  voiceIdentityReviewCapabilityHint
} from "./agentCapabilityHints.js";

const context = { managerPort: "9000", roleId: "Rabi A" };

test("persona sync capability appears only for explicit multi-PC persona intent", () => {
  const hint = personaSyncCapabilityHint("把当前人格同步到另一台电脑", context);
  assert.ok(hint);
  assert.match(hint.join("\n"), /127\.0\.0\.1:9000\/api\/persona-sync\/peers/);
  assert.match(hint.join("\n"), /"roleId": "Rabi A"/);
  assert.equal(personaSyncCapabilityHint("整理今天的会议记录", context), null);
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
