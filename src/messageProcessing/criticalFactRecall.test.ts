import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecentMemory, roleKnowledgeSnapshot } from "../roleKnowledge.js";

test("common public-test and launch-date questions require the recorded group fact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-fact-recall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = createRecentMemory(root, {
    title: "示例项目上线与宣发内部目标（未正式定档）",
    focus: "示例项目上线与宣发内部目标",
    content: "messageId=msg-schedule-1：内部目标约2030年10月15日；messageId=msg-campaign-1：2030年10月集中宣发。不是正式定档。",
    keywords: [
      "上线目标", "上线日期", "什么时候上线", "公测", "公测日期", "什么时候公测",
      "发布日期", "定档", "定档日期", "2030年10月15", "宣发", "宣发日期"
    ]
  });
  for (const query of [
    "什么时候公测？",
    "上线日期是什么？",
    "什么时候上线？",
    "公测日期定了吗？",
    "发布日期是什么？",
    "定档了吗？",
    "2030年10月什么时候开始宣发？"
  ]) {
    const snapshot = roleKnowledgeSnapshot(root, query);
    assert.equal(snapshot.requiredReadItems.some((item) => item.id === memory.id), true, query);
  }
});
