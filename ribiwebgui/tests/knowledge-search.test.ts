import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeItemMatchesQuery } from "../src/knowledgeSearch";

const plan = {
  id: "plan-search",
  title: "改进计划检索",
  focus: "让用户更容易找到计划",
  currentStep: "补充页面过滤逻辑",
  nextAction: "运行 WebGUI 构建",
  waitingFor: "等待产品确认搜索范围",
  blockedBy: "需要秋雨确认上线",
  keywords: ["knowledge", "search"],
  project: { name: "RabiRoute", path: "C:/workspace/RabiRoute" },
  source: { kind: "feedback", summary: "来自计划与记忆页面反馈" },
  attachments: [{ id: "attachment-1", name: "搜索效果图.png", mimeType: "image/png" }],
  steps: [{
    id: "implementation",
    title: "实现全文搜索",
    detail: "步骤详情也应该被搜索到",
    approvalRequest: {
      approver: "秋雨",
      request: "批准发布完整内容检索",
      reason: "现有搜索只覆盖标题和关键词",
      files: [{ path: "ribiwebgui/src/knowledgeSearch.ts", action: "create", change: "递归收集内容值" }],
      commands: [{ command: "npm run webgui:build", purpose: "验证类型和构建" }],
      changes: [{ target: "计划与记忆页面", change: "扩大搜索范围" }],
      validation: ["搜索步骤详情能命中计划"],
      rollback: ["恢复旧过滤函数"],
      outOfScope: ["不修改 Manager 排序"]
    }
  }],
  presentation: {
    status: "进行中",
    tone: "running",
    palette: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" },
    approval: { helper: "请先核对审批材料", missing: ["sourceMessageId"] }
  }
};

test("plan search matches top-level and nested plan content", () => {
  assert.equal(knowledgeItemMatchesQuery(plan, "改进计划检索"), true);
  assert.equal(knowledgeItemMatchesQuery(plan, "步骤详情也应该被搜索到"), true);
  assert.equal(knowledgeItemMatchesQuery(plan, "npm run webgui:build"), true);
  assert.equal(knowledgeItemMatchesQuery(plan, "搜索效果图.png"), true);
  assert.equal(knowledgeItemMatchesQuery(plan, "秋雨"), true);
  assert.equal(knowledgeItemMatchesQuery(plan, "SEARCH"), true);
});

test("knowledge search matches memory body and source metadata", () => {
  const memory = {
    id: "memory-search",
    title: "搜索约定",
    focus: "记住新的搜索范围",
    content: "记忆正文中的任意内容也能命中",
    source: { summary: "用户在 WebGUI 中提出" },
    keywords: ["memory"]
  };

  assert.equal(knowledgeItemMatchesQuery(memory, "记忆正文中的任意内容"), true);
  assert.equal(knowledgeItemMatchesQuery(memory, "WebGUI 中提出"), true);
  assert.equal(knowledgeItemMatchesQuery(memory, "不存在的内容"), false);
  assert.equal(knowledgeItemMatchesQuery(memory, "   "), true);
  assert.equal(knowledgeItemMatchesQuery(memory, null), true);
});

test("object field names are not treated as searchable content", () => {
  assert.equal(knowledgeItemMatchesQuery({ uniqueFieldName: "ordinary value" }, "uniqueFieldName"), false);
});
