import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlan,
  createRecentMemory,
  getPlan,
  getRecentMemory,
  getRoleSkill,
  listPlans,
  listRoleSkills,
  normalizeRoleContextInjection,
  pendingMemoryConsolidation,
  planAcceptsGuidance,
  planApprovalGate,
  planIsBlocked,
  roleContextInjectionPolicy,
  planRequiresApproval,
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

test("plan list cache is invalidated by canonical create and update writes", () => {
  const roleDir = makeRoleDir();
  const created = createPlan(roleDir, {
    id: "cache-plan",
    title: "Cache plan",
    focus: "Verify plan list cache invalidation",
    status: "进行中",
    currentStepId: "cache",
    steps: [{ id: "cache", title: "Verify cache invalidation", status: "进行中" }],
    keywords: ["cache"]
  });
  assert.equal(listPlans(roleDir).find((plan) => plan.id === created.id)?.title, "Cache plan");

  updatePlan(roleDir, created.id, { title: "Updated cache plan" });
  assert.equal(listPlans(roleDir).find((plan) => plan.id === created.id)?.title, "Updated cache plan");
});

test("plan list cache observes direct external plan-file changes", async () => {
  const roleDir = makeRoleDir();
  const created = createPlan(roleDir, {
    id: "external-cache-plan",
    title: "External cache plan",
    focus: "Verify direct file changes invalidate the plan cache",
    status: "进行中",
    currentStepId: "cache",
    steps: [{ id: "cache", title: "Verify external invalidation", status: "进行中" }],
    keywords: ["cache", "external"]
  });
  assert.equal(listPlans(roleDir).find((plan) => plan.id === created.id)?.title, "External cache plan");

  const filePath = path.join(roleDir, "plans", "items", "active", `${created.id}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(filePath, JSON.stringify({ ...raw, title: "Externally updated cache plan" }, null, 2), "utf8");

  let observedTitle = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    observedTitle = listPlans(roleDir).find((plan) => plan.id === created.id)?.title || "";
    if (observedTitle === "Externally updated cache plan") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observedTitle, "Externally updated cache plan");
});

test("plan list cache reparses only the externally changed plan file", { concurrency: false }, async () => {
  const roleDir = makeRoleDir();
  for (let index = 0; index < 40; index += 1) {
    createPlan(roleDir, {
      id: `incremental-cache-${String(index).padStart(2, "0")}`,
      title: `Incremental cache plan ${index}`,
      focus: `Verify incremental plan parsing ${index}`,
      status: "进行中",
      currentStepId: "cache",
      steps: [{ id: "cache", title: "Verify incremental parsing", status: "进行中" }],
      keywords: ["cache", "incremental"]
    });
  }
  assert.equal(listPlans(roleDir).length, 40);

  const changedId = "incremental-cache-17";
  const changedFile = path.join(roleDir, "plans", "items", "active", `${changedId}.json`);
  const raw = JSON.parse(fs.readFileSync(changedFile, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(changedFile, JSON.stringify({ ...raw, title: "Incrementally updated plan" }, null, 2), "utf8");

  const originalReadFile = fs.promises.readFile;
  const originalStat = fs.promises.stat;
  const mutablePromises = fs.promises as unknown as {
    readFile: typeof fs.promises.readFile;
    stat: typeof fs.promises.stat;
  };
  const planFileReads: string[] = [];
  const planFileStats: string[] = [];
  mutablePromises.readFile = (async (filePath: fs.PathLike | fs.promises.FileHandle, ...args: unknown[]) => {
    if (typeof filePath === "string" && filePath.includes(`${path.sep}plans${path.sep}`) && filePath.endsWith(".json")) {
      planFileReads.push(path.resolve(filePath));
    }
    return (originalReadFile as (...callArgs: unknown[]) => Promise<unknown>)(filePath, ...args);
  }) as typeof fs.promises.readFile;
  mutablePromises.stat = (async (filePath: fs.PathLike, ...args: unknown[]) => {
    if (typeof filePath === "string" && filePath.includes(`${path.sep}plans${path.sep}`) && filePath.endsWith(".json")) {
      planFileStats.push(path.resolve(filePath));
    }
    return (originalStat as (...callArgs: unknown[]) => Promise<unknown>)(filePath, ...args);
  }) as typeof fs.promises.stat;
  try {
    let observedTitle = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      observedTitle = listPlans(roleDir).find((plan) => plan.id === changedId)?.title || "";
      if (observedTitle === "Incrementally updated plan") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(observedTitle, "Incrementally updated plan");
  } finally {
    mutablePromises.readFile = originalReadFile;
    mutablePromises.stat = originalStat;
  }

  assert.deepEqual(planFileReads, [path.resolve(changedFile)]);
  assert.deepEqual(planFileStats, [path.resolve(changedFile), path.resolve(changedFile)]);
});

test("plans store managed image, video, and file attachments without persisting base64", () => {
  const roleDir = makeRoleDir();
  const sourceFile = path.join(roleDir, "source-note.txt");
  fs.writeFileSync(sourceFile, "attachment note", "utf8");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZsAAAAASUVORK5CYII=";
  const mp4Base64 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).toString("base64");
  const plan = createPlan(roleDir, {
    id: "plan-attachments",
    title: "带附件的计划",
    focus: "带附件的计划",
    steps: [{ id: "inspect", title: "查看附件", status: "未开始" }],
    keywords: ["附件"],
    attachments: [
      { name: "preview.png", mimeType: "image/png", contentBase64: pngBase64 },
      { name: "demo.mp4", mimeType: "video/mp4", contentBase64: mp4Base64 },
      { path: sourceFile, mimeType: "text/plain" }
    ]
  });

  assert.equal(plan.attachments.length, 3);
  assert.equal(plan.attachments[0]?.kind, "image");
  assert.equal(plan.attachments[1]?.kind, "video");
  assert.equal(plan.attachments[2]?.kind, "file");
  assert.equal(fs.readFileSync(plan.attachments[2]!.path, "utf8"), "attachment note");
  assert.equal(path.relative(path.join(roleDir, "plans", "attachments", plan.id), plan.attachments[0]!.path).startsWith(".."), false);
  const stored = fs.readFileSync(path.join(roleDir, "plans", "items", "active", `${plan.id}.json`), "utf8");
  assert.doesNotMatch(stored, /contentBase64/);
  assert.doesNotMatch(stored, new RegExp(pngBase64.slice(0, 24)));

  const preserved = updatePlan(roleDir, plan.id, { priority: "high" });
  assert.deepEqual(preserved.attachments, plan.attachments);
  const cleared = updatePlan(roleDir, plan.id, { attachments: [] });
  assert.deepEqual(cleared.attachments, []);
});

test("plans can be read and updated directly by id without depending on unrelated plan files", () => {
  const roleDir = makeRoleDir();
  for (let index = 0; index < 100; index += 1) {
    createPlan(roleDir, {
      id: `plan-${String(index).padStart(3, "0")}`,
      title: `计划 ${index}`,
      focus: `计划 ${index}`,
      steps: [{ id: "run", title: "执行", status: "未开始" }],
      keywords: ["计划"]
    });
  }

  const plan = getPlan(roleDir, "plan-050");
  assert.equal(plan?.title, "计划 50");
  assert.equal(updatePlan(roleDir, "plan-050", { priority: "high" }).priority, "high");
  assert.equal(getPlan(roleDir, "plan-049")?.priority, undefined);
});

test("plan attachments reject content that does not match a claimed video type", () => {
  const roleDir = makeRoleDir();
  assert.throws(() => createPlan(roleDir, {
    id: "invalid-video-attachment",
    title: "无效视频附件",
    focus: "无效视频附件",
    steps: [{ id: "inspect", title: "检查视频", status: "未开始" }],
    keywords: ["视频"],
    attachments: [{
      name: "demo.mp4",
      mimeType: "video/mp4",
      contentBase64: Buffer.from("not an mp4").toString("base64")
    }]
  }), /does not match its video type/);
});

test("plan step status transitions record and clear lifecycle timestamps", () => {
  const roleDir = makeRoleDir();
  const created = createPlan(roleDir, {
    id: "plan-step-times",
    title: "记录步骤时间",
    focus: "步骤生命周期时间",
    status: "进行中",
    currentStepId: "implement",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "实现时间记录", status: "进行中" },
      { id: "verify", title: "验证结果", status: "未开始" }
    ],
    keywords: ["计划", "时间"]
  });

  const inspect = created.steps[0]!;
  const implement = created.steps[1]!;
  const verify = created.steps[2]!;
  assert.equal(inspect.startedAt, inspect.completedAt);
  assert.equal(Number.isFinite(Date.parse(inspect.completedAt || "")), true);
  assert.equal(Number.isFinite(Date.parse(implement.startedAt || "")), true);
  assert.equal(implement.completedAt, undefined);
  assert.equal(verify.startedAt, undefined);
  assert.equal(verify.completedAt, undefined);

  const completed = updatePlan(roleDir, created.id, {
    status: "进行中",
    currentStepId: "verify",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "实现时间记录", status: "已完成" },
      { id: "verify", title: "验证结果", status: "进行中" }
    ]
  });
  assert.equal(completed.steps[1]?.startedAt, implement.startedAt);
  assert.equal(Number.isFinite(Date.parse(completed.steps[1]?.completedAt || "")), true);
  assert.equal(Number.isFinite(Date.parse(completed.steps[2]?.startedAt || "")), true);

  const reopened = updatePlan(roleDir, created.id, {
    status: "进行中",
    currentStepId: "implement",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "实现时间记录", status: "进行中" },
      { id: "verify", title: "验证结果", status: "未开始" }
    ]
  });
  assert.equal(reopened.steps[1]?.startedAt, implement.startedAt);
  assert.equal(reopened.steps[1]?.completedAt, undefined);
  assert.equal(reopened.steps[2]?.startedAt, undefined);

  const reset = updatePlan(roleDir, created.id, {
    status: "未开始",
    currentStepId: undefined,
    steps: reopened.steps.map((step) => ({ ...step, status: "未开始" }))
  });
  assert.equal(reset.steps.every((step) => step.startedAt == null && step.completedAt == null), true);
});

test("non-approval blockers are normalized into actionable running plans", () => {
  const roleDir = makeRoleDir();
  const waiting = createPlan(roleDir, {
    id: "plan-waiting-inquiry",
    title: "询问负责人",
    focus: "等待时持续询问直至得到结果",
    status: "进行中",
    currentStepId: "ask-owner",
    waitingFor: "负责人回复",
    blockedBy: "负责人尚未确认",
    steps: [{
      id: "ask-owner",
      title: "询问负责人并取得明确结果",
      status: "进行中",
      waitingFor: "负责人回复",
      blockedBy: "负责人尚未确认"
    }],
    keywords: ["计划", "询问"]
  });

  assert.equal(waiting.isBlocked, undefined);
  assert.equal(waiting.steps[0]?.isBlocked, undefined);

  const legacyBlocked = createPlan(roleDir, {
    id: "plan-blocked-without-reason",
    title: "缺少阻塞原因",
    focus: "验证显式阻塞合同",
    status: "进行中",
    currentStepId: "blocked",
    steps: [{ id: "blocked", title: "无法继续", status: "进行中", isBlocked: true }],
    keywords: ["计划", "阻塞"]
  });
  assert.equal(legacyBlocked.isBlocked, undefined);
  assert.equal(legacyBlocked.steps[0]?.isBlocked, undefined);
  assert.equal(planIsBlocked(legacyBlocked), false);
});

test("only running plans outside approval accept whole-plan guidance", () => {
  const roleDir = makeRoleDir();
  const running = createPlan(roleDir, {
    id: "plan-guidance-running",
    title: "可引导计划",
    focus: "允许用户调整整个计划方向",
    status: "进行中",
    currentStepId: "implement",
    steps: [{ id: "implement", title: "继续实施", status: "进行中" }],
    keywords: ["引导"]
  });
  const pending = createPlan(roleDir, {
    id: "plan-guidance-pending",
    title: "未开始计划",
    focus: "尚未开始",
    status: "未开始",
    steps: [{ id: "prepare", title: "准备", status: "未开始" }],
    keywords: ["引导"]
  });
  const approval = createPlan(roleDir, {
    id: "plan-guidance-approval",
    title: "审批计划",
    focus: "等待正式审批",
    status: "进行中",
    currentStepId: "approve",
    steps: [{
      id: "approve",
      title: "等待审批",
      status: "进行中",
      approvalRequest: { request: "批准方案", reason: "涉及外部变更" }
    }],
    keywords: ["审批"]
  });

  assert.equal(planAcceptsGuidance(running), true);
  assert.equal(planAcceptsGuidance(pending), false);
  assert.equal(planAcceptsGuidance(approval), false);
});

test("plan attachments enforce count, per-file, and total size limits", () => {
  const roleDir = makeRoleDir();
  const base = {
    title: "附件限制",
    focus: "附件限制",
    steps: [{ id: "inspect", title: "检查附件", status: "未开始" }],
    keywords: ["附件"]
  };
  assert.throws(() => createPlan(roleDir, {
    ...base,
    id: "too-many-attachments",
    attachments: Array.from({ length: 9 }, (_, index) => ({
      name: `note-${index}.txt`,
      mimeType: "text/plain",
      contentBase64: Buffer.from("x").toString("base64")
    }))
  }), /at most 8 attachments/);

  const oversized = path.join(roleDir, "oversized.bin");
  fs.writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => createPlan(roleDir, {
    ...base,
    id: "oversized-attachment",
    attachments: [{ path: oversized }]
  }), /exceeds 10485760 bytes/);

  const largeFiles = Array.from({ length: 3 }, (_, index) => {
    const filePath = path.join(roleDir, `large-${index}.bin`);
    fs.writeFileSync(filePath, Buffer.alloc(9 * 1024 * 1024, index));
    return { path: filePath };
  });
  assert.throws(() => createPlan(roleDir, {
    ...base,
    id: "attachments-total-too-large",
    attachments: largeFiles
  }), /exceed 26214400 bytes in total/);
});

test("context injection defaults focused and keeps a legacy rollback mode", () => {
  const roleDir = makeRoleDir();
  assert.deepEqual(roleContextInjectionPolicy(roleDir), {
    mode: "focused",
    requiredReadLimit: 3,
    matchedItemLimit: 3,
    personaMaxChars: 1600
  });

  writePersonaConfig(roleDir, {
    contextInjection: {
      mode: "legacy",
      relevantKnowledgeLimit: 7,
      personaMaxChars: 99999
    }
  });
  assert.deepEqual(roleContextInjectionPolicy(roleDir), {
    mode: "legacy",
    requiredReadLimit: 7,
    matchedItemLimit: 7,
    personaMaxChars: 6000
  });
  assert.equal(normalizeRoleContextInjection({ mode: "unknown" }).mode, "focused");
});

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
    blockedBy: "设计稿缺失",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "实现页面", status: "进行中", blockedBy: "缺少最终设计稿" },
      { id: "verify", title: "验证结果", status: "未开始" }
    ],
    keywords: ["步骤"]
  });

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.currentStepId, "implement");
  assert.equal(plan.blockedBy, "设计稿缺失");
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

test("paused plans preserve their resume step without remaining approval-active", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    title: "暂停中的实施计划",
    focus: "暂停中的实施计划",
    status: "暂停",
    currentStepId: "implement",
    currentStep: "保留当前实现位置，等待恢复",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      {
        id: "implement",
        title: "继续实现",
        status: "进行中",
        blockedBy: "用户要求暂时跳过",
        approvalRequest: {
          request: "批准继续实现。",
          reason: "恢复后才需要审批。",
          files: [{ path: "src/example.ts", action: "modify", change: "继续实现。" }],
          commands: [],
          changes: [],
          validation: ["运行测试。"],
          rollback: ["回退改动。"],
          outOfScope: ["不发布。"]
        }
      }
    ],
    keywords: ["暂停"]
  });

  assert.equal(plan.status, "暂停");
  assert.equal(plan.currentStepId, "implement");
  assert.equal(planRequiresApproval(plan), false);
  const resumed = updatePlan(roleDir, plan.id, {
    status: "进行中",
    isBlocked: true,
    blockedBy: "用户尚未批准继续实现当前文件改动"
  });
  assert.equal(resumed.status, "进行中");
  assert.equal(resumed.isBlocked, undefined);
  assert.equal(planApprovalGate(resumed).state, "preparing");
});

test("approval steps remain writable while Manager can distinguish incomplete and concrete contracts", () => {
  const roleDir = makeRoleDir();
  const base = {
    title: "审批具体修改",
    focus: "审批具体修改",
    status: "进行中",
    currentStepId: "approve",
    currentStep: "等待用户审批执行范围",
    keywords: ["审批"]
  };

  const incomplete = createPlan(roleDir, {
    ...base,
    isBlocked: true,
    blockedBy: "用户尚未批准是否执行结构化审批改动",
    steps: [{ id: "approve", title: "等待修改审批", status: "进行中", isBlocked: true, blockedBy: "用户尚未批准是否执行结构化审批改动" }]
  });
  assert.equal(incomplete.steps[0]?.approvalRequest, undefined);
  assert.equal(incomplete.isBlocked, undefined);
  assert.equal(planApprovalGate(incomplete).state, "preparing");

  const plan = updatePlan(roleDir, incomplete.id, {
    steps: [{
      id: "approve",
      title: "等待修改审批",
      status: "进行中",
      isBlocked: true,
      blockedBy: "秋雨尚未批准结构化审批合同改动",
      approvalRequest: {
        approver: "秋雨",
        request: "批准实现结构化审批合同并同步双端展示。",
        recommendation: "批准当前最小代码与文档改动。",
        alternatives: ["要求缩小范围后重新申请", "否决并保留现状"],
        reason: "当前通用安全提示无法说明批准后的真实动作。",
        files: [{
          path: "src/roleKnowledge.ts",
          action: "modify",
          change: "新增 approvalRequest Schema、规范化和写入校验。"
        }],
        commands: [{
          command: "npm test -- --runInBand",
          purpose: "运行 Node 定向回归。",
          expectedEffect: "只读取代码并产生测试输出。"
        }],
        changes: [],
        validation: ["审批卡片展示完整材料，且不完整合同禁止审批。"],
        rollback: ["若验证失败，仅回退本合同列出的代码和文档改动。"],
        outOfScope: ["不提交、不推送、不修改运行期 data/。"],
        requestedAt: "2026-07-28T00:00:00.000Z",
        feedbackId: "feedback-approval-1",
        responseStatus: "pending"
      }
    }]
  });

  assert.equal(plan.steps[0]?.approvalRequest?.files[0]?.path, "src/roleKnowledge.ts");
  assert.equal(plan.isBlocked, true);
  assert.equal(plan.steps[0]?.isBlocked, true);
  assert.equal(planApprovalGate(plan).state, "pending");
  const returnedToIncomplete = updatePlan(roleDir, plan.id, {
    steps: [{ id: "approve", title: "等待修改审批", status: "进行中", isBlocked: true, blockedBy: "用户尚未批准是否执行结构化审批改动" }]
  });
  assert.equal(returnedToIncomplete.steps[0]?.approvalRequest, undefined);
  assert.equal(returnedToIncomplete.isBlocked, undefined);
  assert.equal(updatePlan(roleDir, plan.id, { priority: "high" }).priority, "high");
  const rederived = updatePlan(roleDir, plan.id, {
    isBlocked: false,
    blockedBy: "",
    steps: [{ id: "approve", title: "等待修改审批", status: "进行中", isBlocked: false, blockedBy: "", approvalRequest: plan.steps[0]?.approvalRequest }]
  });
  assert.equal(rederived.isBlocked, true);
  assert.equal(rederived.steps[0]?.isBlocked, true);

  const approved = updatePlan(roleDir, plan.id, {
    isBlocked: false,
    blockedBy: "",
    steps: [{
      ...plan.steps[0],
      isBlocked: false,
      blockedBy: "",
      approvalRequest: { ...plan.steps[0]?.approvalRequest, responseStatus: "approved" }
    }]
  });
  assert.equal(approved.isBlocked, undefined);
  assert.equal(approved.steps[0]?.approvalRequest?.responseStatus, "approved");
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
