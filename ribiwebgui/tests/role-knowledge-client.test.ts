import assert from "node:assert/strict";
import test from "node:test";
import type { RolePlan } from "../src/types.js";
import { normalizeRolePlanFromManager } from "../src/roleKnowledgeClient.js";

function plan(presentation?: RolePlan["presentation"]): RolePlan {
  return {
    id: "plan",
    title: "Plan",
    focus: "Plan",
    status: "进行中",
    attachments: [],
    steps: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    keywords: [],
    presentation: presentation as RolePlan["presentation"],
    approval: { count: 0 }
  };
}

test("WebGUI preserves Manager stages and does not derive a second stage when presentation is absent", () => {
  const managerStage = normalizeRolePlanFromManager(plan({
    status: "待资料",
    tone: "waiting_external",
    sortBucket: 3,
    views: ["current", "plans"],
    palette: { accent: "#f59e0b", background: "#fff7e6", foreground: "#a96008" },
    approval: { state: "none", enabled: false, label: "无需审批", helper: "", missing: [] }
  }));
  const missingPresentation = normalizeRolePlanFromManager(plan(undefined));

  assert.equal(managerStage.presentation.status, "待资料");
  assert.equal(managerStage.presentation.tone, "waiting_external");
  assert.equal(missingPresentation.presentation.status, "状态未知");
  assert.equal(missingPresentation.presentation.tone, "unknown");
});

test("WebGUI preserves the Manager-owned QA acceptance label, tone, and palette", () => {
  const qa = normalizeRolePlanFromManager(plan({
    status: "等待 QA 验收",
    tone: "qa",
    sortBucket: 1,
    views: ["current", "plans"],
    palette: { accent: "#8e63c7", background: "#f3e8ff", foreground: "#7e22ce" },
    approval: { state: "none", enabled: false, label: "无需审批", helper: "", missing: [] }
  }));

  assert.equal(qa.presentation.status, "等待 QA 验收");
  assert.equal(qa.presentation.tone, "qa");
  assert.deepEqual(qa.presentation.palette, {
    accent: "#8e63c7",
    background: "#f3e8ff",
    foreground: "#7e22ce"
  });
});
