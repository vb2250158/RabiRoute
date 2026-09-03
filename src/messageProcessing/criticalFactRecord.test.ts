import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCriticalProjectFactRecord } from "./criticalFactRecord.js";
import type { MessageProcessingRequirement } from "./board.js";
import { createPlan, createRecentMemory } from "../roleKnowledge.js";

function requirement(messageId = "msg-schedule-1"): MessageProcessingRequirement {
  return {
    id: "requirement-1",
    dedupeKey: "message-group:requirement-1",
    kind: "message_reply",
    replyPolicy: "agent_decides",
    status: "processing",
    source: {
      routeId: "demo-main",
      roleId: "DemoPersona",
      endpoint: "group",
      conversationKey: "group:example-group",
      sender: "示例成员",
      routeKinds: ["napcat"],
      messageIds: [messageId],
      summary: "示例项目暂以2030年10月15日为内部上线目标"
    },
    criticalFacts: [{ kind: "schedule", evidence: "2030年10月15日为内部上线目标" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dueAt: new Date().toISOString()
  };
}

test("verifies a persisted plan contains the original group message id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-fact-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "roles", "DemoPersona");
  fs.mkdirSync(roleDir, { recursive: true });
  const plan = createPlan(roleDir, {
    title: "公测上线目标",
    focus: "公测上线目标",
    goal: "记录内部上线目标",
    status: "待讨论",
    currentStep: "记录群内排期",
    currentStepId: "record-schedule",
    nextAction: "等待正式定档",
    steps: [{ id: "record-schedule", title: "记录群内排期", status: "进行中" }],
    keywords: ["公测", "上线", "2030年10月15日"],
    source: { type: "group_message", id: "msg-schedule-1" }
  });
  assert.doesNotThrow(() => verifyCriticalProjectFactRecord({
    workspaceRoot: root,
    roleDir,
    requirement: requirement(),
    disposition: {
      status: "recorded",
      record: { type: "plan", planId: plan.id },
      evidence: "计划已回读",
      verifiedAt: new Date().toISOString()
    }
  }));
});

test("rejects a real plan or memory that omitted the original group message id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-fact-missing-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "roles", "DemoPersona");
  fs.mkdirSync(roleDir, { recursive: true });
  const memory = createRecentMemory(roleDir, {
    title: "上线目标",
    focus: "排期",
    content: "示例项目内部目标约为2030年10月15日",
    keywords: ["上线"]
  });
  assert.throws(() => verifyCriticalProjectFactRecord({
    workspaceRoot: root,
    roleDir,
    requirement: requirement(),
    disposition: {
      status: "recorded",
      record: { type: "memory", memoryId: memory.id },
      evidence: "记忆已回读",
      verifiedAt: new Date().toISOString()
    }
  }), /does not contain any source messageId/);
});

test("verifies a project document exists and contains the source message id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-fact-document-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documentPath = path.join(root, "docs", "release-target.md");
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, "来源消息：msg-schedule-1\n示例项目内部上线目标：约2030年10月15日。\n", "utf8");
  assert.doesNotThrow(() => verifyCriticalProjectFactRecord({
    workspaceRoot: root,
    requirement: requirement(),
    disposition: {
      status: "recorded",
      record: { type: "document", relativePath: "docs/release-target.md" },
      evidence: "文档已回读",
      verifiedAt: new Date().toISOString()
    }
  }));
});

test("rejects absolute and parent-relative document references", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-fact-document-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(path.dirname(root), "outside-project-fact.md");
  fs.writeFileSync(outside, "来源消息：msg-schedule-1\n", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  for (const relativePath of [outside, "../outside-project-fact.md"]) {
    assert.throws(() => verifyCriticalProjectFactRecord({
      workspaceRoot: root,
      requirement: requirement(),
      disposition: {
        status: "recorded",
        record: { type: "document", relativePath },
        evidence: "文档已回读",
        verifiedAt: new Date().toISOString()
      }
    }), /must be relative|escapes configured root/);
  }
});
