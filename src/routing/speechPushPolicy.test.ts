import assert from "node:assert/strict";
import test from "node:test";
import { decideSpeechPush } from "./speechPushPolicy.js";

test("hot speech push always notifies the Agent", () => {
  assert.deepEqual(decideSpeechPush("普通会议内容", "hot", []), {
    mode: "hot",
    shouldNotifyAgent: true,
    reason: "hot"
  });
});

test("keyword speech push records silently until a persona keyword is mentioned", () => {
  assert.deepEqual(decideSpeechPush("先讨论排期", "keyword", ["星海", "星海建造师"]), {
    mode: "keyword",
    shouldNotifyAgent: false,
    reason: "keyword_not_matched"
  });
  assert.deepEqual(decideSpeechPush("星海，看看刚才的上下文", "keyword", ["星海", "星海建造师"]), {
    mode: "keyword",
    shouldNotifyAgent: true,
    matchedKeyword: "星海",
    reason: "keyword_matched"
  });
});

test("keyword mode with no persona keywords never falls back to hot delivery", () => {
  assert.deepEqual(decideSpeechPush("任何内容", "keyword", []), {
    mode: "keyword",
    shouldNotifyAgent: false,
    reason: "keyword_not_configured"
  });
});
