import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlan,
  createRecentMemory,
  getRecentMemory,
  getRoleSkill,
  listRoleSkills,
  pendingMemoryConsolidation,
  roleKnowledgeSnapshot,
  updatePlan,
  updateRecentMemory,
  validateRoleKnowledge
} from "./roleKnowledge.js";

function makeRoleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-"));
}

function writeRecentMemory(roleDir: string, memory: Record<string, unknown>): void {
  const filePath = path.join(roleDir, "memory", "recent", `${memory.id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf8");
}

function writeConsolidatedMemory(roleDir: string, memory: Record<string, unknown>): void {
  const filePath = path.join(roleDir, "memory", "consolidated", `${memory.id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf8");
}

function writeSkill(roleDir: string, fileName: string, text: string): void {
  const filePath = path.join(roleDir, "skills", fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function writePersonaConfig(roleDir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), JSON.stringify(config, null, 2), "utf8");
}

function readRecentMemory(roleDir: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", `${id}.json`), "utf8")) as Record<string, unknown>;
}

function readConsolidatedMemory(roleDir: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "consolidated", `${id}.json`), "utf8")) as Record<string, unknown>;
}

test("keyword recall touches memory viewedAt and delays consolidation", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-keyword",
    title: "旧记忆",
    content: "这条记忆已经很久没有活动。",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["关键词命中"]
  });

  const snapshot = roleKnowledgeSnapshot(roleDir, "这次消息包含关键词命中");
  assert.deepEqual(snapshot.matchedItems, [{ id: "memory-keyword", title: "旧记忆", type: "recent_memory" }]);
  assert.equal(snapshot.requiredReadItems[0]?.id, "memory-keyword");
  assert.equal(snapshot.requiredReadItems[0]?.endpoint.endsWith("/memory/recent/memory-keyword"), true);

  const touched = readRecentMemory(roleDir, "memory-keyword");
  assert.equal(touched.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(typeof touched.viewedAt, "string");
  assert.equal(pendingMemoryConsolidation(roleDir, "api", 24, 72, false), null);
});

test("reading or updating a recent memory refreshes viewedAt", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-read",
    title: "待读取记忆",
    content: "原内容",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["读取"]
  });

  const read = getRecentMemory(roleDir, "memory-read");
  assert.equal(read?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(typeof read?.viewedAt, "string");

  const updated = updateRecentMemory(roleDir, "memory-read", { content: "新内容" });
  assert.equal(updated.content, "新内容");
  assert.equal(updated.viewedAt, updated.updatedAt);
});

test("updating a stale recent memory requires an explicit read first", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-stale-update",
    title: "过期近期记忆",
    focus: "近期记忆编辑窗口",
    content: "旧内容",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["编辑窗口"]
  });

  assert.throws(
    () => updateRecentMemory(roleDir, "memory-stale-update", { content: "未经读取直接修改" }),
    /outside the 24-hour editable window/
  );

  const read = getRecentMemory(roleDir, "memory-stale-update");
  assert.equal(typeof read?.viewedAt, "string");
  const updated = updateRecentMemory(roleDir, "memory-stale-update", { content: "读取确认后修改" });
  assert.equal(updated.content, "读取确认后修改");
});

test("consolidated memories can enter required read items and refresh viewedAt", () => {
  const roleDir = makeRoleDir();
  writeConsolidatedMemory(roleDir, {
    id: "memory-stable",
    title: "稳定项目边界",
    content: "RabiRoute 不应该变成完整 Agent OS。",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["项目边界", "Agent OS"]
  });

  const snapshot = roleKnowledgeSnapshot(roleDir, "请确认项目边界");
  assert.equal(snapshot.requiredReadItems[0]?.id, "memory-stable");
  assert.equal(snapshot.requiredReadItems[0]?.type, "consolidated_memory");
  assert.equal(snapshot.requiredReadItems[0]?.endpoint.endsWith("/memory/consolidated/memory-stable"), true);
  assert.deepEqual(snapshot.matchedItems, [{ id: "memory-stable", title: "稳定项目边界", type: "consolidated_memory" }]);

  const touched = readConsolidatedMemory(roleDir, "memory-stable");
  assert.equal(touched.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(typeof touched.viewedAt, "string");
});

test("active recent memories get a small boost without overwhelming explicit matches", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-active",
    title: "活跃近期记忆",
    content: "活跃内容",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    keywords: ["共同关键词"]
  });
  writeRecentMemory(roleDir, {
    id: "memory-explicit",
    title: "明确标题记忆",
    content: "旧内容",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["共同关键词"]
  });
  writeRecentMemory(roleDir, {
    id: "memory-irrelevant-active",
    title: "无关活跃记忆",
    content: "无关内容",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    keywords: ["无关词"]
  });

  const snapshot = roleKnowledgeSnapshot(roleDir, "共同关键词，同时请看明确标题记忆");
  assert.equal(snapshot.requiredReadItems[0]?.id, "memory-explicit");
  assert.equal(snapshot.requiredReadItems[1]?.id, "memory-active");
  assert.equal(snapshot.requiredReadItems.some((item) => item.id === "memory-irrelevant-active"), false);
});

test("memory content alone does not create a required read match", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-content-only",
    title: "普通标题",
    content: "只有内容里包含隐藏短语。",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["其他关键词"]
  });

  const snapshot = roleKnowledgeSnapshot(roleDir, "隐藏短语");
  assert.deepEqual(snapshot.requiredReadItems, []);
  assert.deepEqual(snapshot.matchedItems, []);
});

test("role knowledge writes enforce configured limits and a single-line focus", () => {
  const roleDir = makeRoleDir();
  writePersonaConfig(roleDir, {
    knowledgeLimits: {
      plan: {
        titleChars: 30,
        focusChars: 20,
        currentStepChars: 20,
        nextActionChars: 20,
        waitingForChars: 20,
        sourceSummaryChars: 20,
        keywordChars: 10,
        maxKeywords: 2,
        totalChars: 100
      },
      memory: {
        titleChars: 30,
        focusChars: 20,
        contentChars: 20,
        sourceSummaryChars: 20,
        keywordChars: 10,
        maxKeywords: 2,
        totalChars: 80
      }
    }
  });

  const plan = createPlan(roleDir, {
    title: "每日证据检查",
    focus: "每日证据检查",
    currentStep: "读取权威状态",
    steps: [{ id: "read-status", title: "读取权威状态", status: "未开始" }],
    keywords: ["每日", "证据"]
  });
  assert.equal(plan.focus, "每日证据检查");

  const memory = createRecentMemory(roleDir, {
    title: "模拟器偏好",
    focus: "模拟器偏好",
    content: "安卓游戏统一使用雷电模拟器。",
    keywords: ["雷电"]
  });
  assert.equal(memory.focus, "模拟器偏好");

  assert.throws(() => createPlan(roleDir, {
    title: "缺少焦点",
    keywords: ["焦点"]
  }), /Plan focus is required/);
  assert.throws(() => createRecentMemory(roleDir, {
    title: "缺少焦点",
    content: "内容",
    keywords: ["焦点"]
  }), /Memory focus is required/);

  assert.throws(() => createPlan(roleDir, {
    title: "混合计划",
    focus: "每日\n周常",
    keywords: ["混合"]
  }), /focus must be a single line/);
  assert.throws(() => createPlan(roleDir, {
    title: "过长步骤",
    focus: "过长步骤",
    currentStep: "这是一段故意超过二十个字符限制的当前步骤内容",
    steps: [{ id: "long-step", title: "检查步骤", status: "未开始" }],
    keywords: ["长度"]
  }), /currentStep exceeds 20 characters/);
  assert.throws(() => createRecentMemory(roleDir, {
    title: "过长记忆",
    focus: "过长记忆",
    content: "这是一段故意超过二十个字符限制的近期记忆内容",
    keywords: ["长度"]
  }), /content exceeds 20 characters/);
  assert.throws(() => createRecentMemory(roleDir, {
    title: "关键词过多",
    focus: "关键词过多",
    content: "内容",
    keywords: ["一", "二", "三"]
  }), /maximum is 2/);
});

test("plans require ordered steps and one explicit current step", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    title: "结构化计划",
    focus: "结构化计划",
    status: "进行中",
    currentStepId: "implement",
    currentStep: "正在实现页面",
    blockedBy: "设计稿尚未确认",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "实现页面", status: "进行中", blockedBy: "缺少最终设计稿" },
      { id: "verify", title: "验证结果", status: "未开始" }
    ],
    keywords: ["步骤"]
  });

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.currentStepId, "implement");
  assert.equal(plan.blockedBy, "设计稿尚未确认");
  assert.equal(plan.steps[1]?.status, "进行中");
  assert.equal(plan.steps[1]?.blockedBy, "缺少最终设计稿");

  assert.throws(() => createPlan(roleDir, {
    title: "没有步骤",
    focus: "没有步骤",
    keywords: ["步骤"]
  }), /Plan steps are required/);

  assert.throws(() => createPlan(roleDir, {
    title: "两个当前步骤",
    focus: "两个当前步骤",
    status: "进行中",
    currentStepId: "one",
    steps: [
      { id: "one", title: "第一步", status: "进行中" },
      { id: "two", title: "第二步", status: "进行中" }
    ],
    keywords: ["步骤"]
  }), /only one in-progress step/);
});

test("plans persist an exact Codex task binding and completion hook target", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    title: "会话任务完成提醒",
    focus: "会话任务完成提醒",
    status: "未开始",
    steps: [{ id: "run", title: "运行绑定任务", status: "未开始" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "session-plan-worker",
      sessionTitle: "计划执行任务",
      workspace: "C:\\workspace\\project",
      completionHook: { enabled: true, gatewayId: "Rabi__main" }
    },
    keywords: ["会话任务"]
  });

  assert.deepEqual(plan.taskBinding, {
    agentType: "codex",
    sessionId: "session-plan-worker",
    sessionTitle: "计划执行任务",
    workspace: "C:\\workspace\\project",
    completionHook: { enabled: true, gatewayId: "Rabi__main" }
  });
  const defaultEnabled = createPlan(roleDir, {
    title: "默认开启完成提醒",
    focus: "默认开启完成提醒",
    status: "未开始",
    steps: [{ id: "run", title: "运行绑定任务", status: "未开始" }],
    taskBinding: { agentType: "codex", sessionId: "session-default-hook" },
    keywords: ["会话任务"]
  });
  assert.deepEqual(defaultEnabled.taskBinding?.completionHook, { enabled: true, gatewayId: undefined });
  const disabled = updatePlan(roleDir, defaultEnabled.id, {
    taskBinding: {
      agentType: "codex",
      sessionId: "session-default-hook",
      completionHook: { enabled: false }
    }
  });
  assert.equal(disabled.taskBinding?.completionHook?.enabled, false);
  assert.throws(() => createPlan(roleDir, {
    title: "缺少任务 ID",
    focus: "缺少任务 ID",
    steps: [{ id: "run", title: "运行绑定任务", status: "未开始" }],
    taskBinding: { agentType: "codex", completionHook: { enabled: true } },
    keywords: ["会话任务"]
  }), /taskBinding\.sessionId is required/);
  assert.throws(() => updatePlan(roleDir, plan.id, {
    taskBinding: { agentType: "remote", sessionId: "remote-session" }
  }), /Unsupported plan taskBinding agentType/);
});

test("role knowledge validation reports legacy items that exceed current limits", () => {
  const roleDir = makeRoleDir();
  writePersonaConfig(roleDir, {
    knowledgeLimits: {
      memory: { contentChars: 5, totalChars: 100 }
    }
  });
  writeRecentMemory(roleDir, {
    id: "memory-legacy-long",
    title: "旧记忆",
    content: "这条旧记忆已经超过新限制",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    keywords: ["旧记忆"]
  });

  const result = validateRoleKnowledge(roleDir);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.id, "memory-legacy-long");
  assert.match(result.issues[0]?.message ?? "", /content exceeds 5 characters/);
});

test("role skills are listed from markdown metadata without content", () => {
  const roleDir = makeRoleDir();
  writeSkill(roleDir, "companionship.md", `---
id: companionship-response
title: Companionship response
summary: Respond to emotion before solving the task.
keywords: companionship, emotion, comfort
source: example role skill
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Companionship response

This full body should only appear when the skill is read directly.
`);

  const skills = listRoleSkills(roleDir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "companionship-response");
  assert.equal(skills[0].summary, "Respond to emotion before solving the task.");
  assert.equal("content" in skills[0], false);

  const detail = getRoleSkill(roleDir, "companionship-response");
  assert.match(detail?.content ?? "", /full body/);
});

test("role skill metadata can enter required read without scanning body text", () => {
  const roleDir = makeRoleDir();
  writeSkill(roleDir, "routing-guide.md", `---
id: routing-guide
title: Routing guide
summary: Explain route kind and policy router concepts.
keywords: route kind, policy router
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Routing guide

Hidden-only body phrase.
`);

  const matched = roleKnowledgeSnapshot(roleDir, "Please explain route kind.");
  assert.equal(matched.requiredReadItems[0]?.id, "routing-guide");
  assert.equal(matched.requiredReadItems[0]?.type, "role_skill");
  assert.equal(matched.requiredReadItems[0]?.endpoint.endsWith("/skills/routing-guide"), true);
  assert.deepEqual(matched.matchedSkills.map((item) => item.id), ["routing-guide"]);

  const hidden = roleKnowledgeSnapshot(roleDir, "Hidden-only body phrase.");
  assert.deepEqual(hidden.requiredReadItems, []);
});
