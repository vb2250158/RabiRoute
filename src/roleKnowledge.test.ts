import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveCompletedPlans,
  createPlan,
  createRecentMemory,
  completeMemoryConsolidation,
  getPlan,
  getRecentMemory,
  getRoleSkill,
  listActiveRecentMemories,
  listArchivedMemories,
  listConsolidatedMemories,
  listPlanHistory,
  listPlans,
  listPlansAsync,
  listRecentMemories,
  listRoleSkills,
  markMemoryConsolidationRunDelivered,
  migrateRolePlanLayout,
  normalizeRoleContextInjection,
  nextMemoryConsolidationTriggerAt,
  pendingMemoryConsolidation,
  planAcceptsGuidance,
  planApprovalGate,
  planIsBlocked,
  presentRoleMemory,
  presentRoleMemories,
  roleContextInjectionPolicy,
  roleMemoryCounts,
  planRequiresApproval,
  roleKnowledgeSnapshot,
  subscribePlanUpdates,
  updatePlan,
  updateRecentMemory,
  validateRoleKnowledge
} from "./roleKnowledge.js";
import { appendPlanFeedback, listPlanFeedback, storePlanFeedbackAttachments } from "./planFeedback.js";
import {
  legacyPlanAttachmentDirectory,
  legacyPlanFeedbackAttachmentDirectory,
  legacyPlanFeedbackFile,
  legacyPlanHistoryFile,
  planAttachmentDirectory,
  planDirectory,
  planFeedbackAttachmentDirectory,
  planFeedbackFile,
  planHistoryFile,
  planJsonFile
} from "./planStorageLayout.js";

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

test("plan history keeps snapshots after updates and archive moves", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    id: "history-plan",
    title: "保留审批留痕",
    focus: "验证计划版本记录",
    status: "已完成",
    steps: [{ id: "approve", title: "审批", status: "已完成", approvalRequest: {
      approver: "负责人",
      request: "批准计划留痕实现",
      recommendation: "按步骤保留合同",
      alternatives: ["只保留当前状态"],
      reason: "后续 Agent 需要复核",
      files: [{ path: "src/roleKnowledge.ts", action: "modify", change: "写入计划历史" }],
      commands: [],
      changes: [],
      validation: ["检查历史接口返回"],
      rollback: ["保留当前计划文件"],
      outOfScope: ["删除旧记录"],
      requestedAt: "2026-08-20T00:00:00.000Z",
      responseStatus: "approved"
    }}],
    keywords: ["留痕"]
  });
  appendPlanFeedback(roleDir, {
    id: "history-feedback",
    roleId: "Role",
    planId: plan.id,
    planTitle: plan.title,
    stepId: "approve",
    stepTitle: "审批",
    kind: "approval_suggestion",
    author: "user",
    source: "webgui",
    text: "批准并保留完整记录。",
    attachments: [],
    planAttachments: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    deliveryStatus: "record_only"
  });
  updatePlan(roleDir, plan.id, { title: "保留审批和引导留痕" });
  const archived = archiveCompletedPlans(roleDir, -1);

  const history = listPlanHistory(roleDir, plan.id);
  assert.deepEqual(history.map((item) => item.kind), ["created", "updated", "archived"]);
  assert.equal(history[0]?.after.steps[0]?.approvalRequest?.request, "批准计划留痕实现");
  assert.equal(history[1]?.before?.title, "保留审批留痕");
  assert.equal(history[2]?.after.status, "已归档");
  assert.equal(archived[0]?.id, plan.id);
  assert.equal(listPlanFeedback(roleDir, plan.id)[0]?.text, "批准并保留完整记录。");
});

test("automatic archival clears a legacy completed-plan current step", () => {
  const roleDir = makeRoleDir();
  const activeDir = path.join(roleDir, "plans", "items", "active");
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(path.join(activeDir, "legacy-completed.json"), `${JSON.stringify({
    id: "legacy-completed",
    title: "Legacy completed plan",
    focus: "Archive a legacy completed record safely",
    status: "已完成",
    currentStepId: "done",
    steps: [{ id: "done", title: "Done", status: "已完成" }],
    keywords: ["legacy"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");

  const archived = archiveCompletedPlans(roleDir, -1);

  assert.equal(archived[0]?.status, "已归档");
  assert.equal(archived[0]?.currentStepId, undefined);
  assert.equal(getPlan(roleDir, "legacy-completed")?.currentStepId, undefined);
});


test("legacy plan artifacts migrate into one plan directory without reading attachment bodies", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    id: "legacy-layout-plan",
    title: "Legacy layout plan",
    focus: "Move one plan into one directory",
    status: "进行中",
    currentStepId: "move",
    steps: [{ id: "move", title: "Move plan", status: "进行中" }],
    keywords: ["legacy", "migration"],
    attachments: [{ name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("plan attachment", "utf8").toString("base64") }]
  });
  const feedbackAttachments = storePlanFeedbackAttachments(roleDir, plan.id, "legacy-feedback", [{
    name: "review.txt",
    mimeType: "text/plain",
    contentBase64: Buffer.from("feedback attachment", "utf8").toString("base64")
  }]);
  appendPlanFeedback(roleDir, {
    id: "legacy-feedback",
    roleId: "Role",
    planId: plan.id,
    planTitle: plan.title,
    kind: "guidance",
    author: "user",
    source: "webgui",
    text: "Keep the plan files together.",
    attachments: feedbackAttachments,
    planAttachments: plan.attachments,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    deliveryStatus: "record_only"
  });

  const currentDirectory = planDirectory(roleDir, plan.id, "active");
  const legacyAttachmentDirectory = legacyPlanAttachmentDirectory(roleDir, plan.id);
  const legacyFeedbackAttachmentDirectory = legacyPlanFeedbackAttachmentDirectory(roleDir, "legacy-feedback");
  const currentAttachmentDirectory = planAttachmentDirectory(roleDir, plan.id, "active");
  const currentFeedbackAttachmentDirectory = planFeedbackAttachmentDirectory(roleDir, plan.id, "legacy-feedback", "active");
  const remap = (text: string): string => text
    .replaceAll(currentAttachmentDirectory, legacyAttachmentDirectory)
    .replaceAll(currentFeedbackAttachmentDirectory, legacyFeedbackAttachmentDirectory);
  const planJson = remap(fs.readFileSync(planJsonFile(roleDir, plan.id, "active"), "utf8"));
  const historyJsonl = remap(fs.readFileSync(planHistoryFile(roleDir, plan.id, "active"), "utf8"));
  const feedbackJsonl = remap(fs.readFileSync(planFeedbackFile(roleDir, plan.id, "active"), "utf8"));
  fs.mkdirSync(path.join(roleDir, "plans", "items", "active"), { recursive: true });
  fs.mkdirSync(path.dirname(legacyAttachmentDirectory), { recursive: true });
  fs.mkdirSync(path.dirname(legacyFeedbackAttachmentDirectory), { recursive: true });
  fs.mkdirSync(path.dirname(legacyPlanHistoryFile(roleDir, plan.id)), { recursive: true });
  fs.mkdirSync(path.dirname(legacyPlanFeedbackFile(roleDir, plan.id)), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "plans", "items", "active", `${plan.id}.json`), planJson, "utf8");
  fs.writeFileSync(legacyPlanHistoryFile(roleDir, plan.id), historyJsonl, "utf8");
  fs.writeFileSync(legacyPlanFeedbackFile(roleDir, plan.id), feedbackJsonl, "utf8");
  fs.renameSync(currentAttachmentDirectory, legacyAttachmentDirectory);
  fs.renameSync(currentFeedbackAttachmentDirectory, legacyFeedbackAttachmentDirectory);
  fs.rmSync(currentDirectory, { recursive: true, force: true });

  const migrated = migrateRolePlanLayout(roleDir);
  assert.deepEqual(migrated, { migrated: 1, skipped: 0, failures: [] });
  assert.equal(fs.existsSync(planJsonFile(roleDir, plan.id, "active")), true);
  assert.equal(fs.existsSync(planHistoryFile(roleDir, plan.id, "active")), true);
  assert.equal(fs.existsSync(planFeedbackFile(roleDir, plan.id, "active")), true);
  assert.equal(fs.existsSync(legacyAttachmentDirectory), false);
  assert.equal(fs.existsSync(legacyFeedbackAttachmentDirectory), false);
  assert.equal(getPlan(roleDir, plan.id)?.attachments[0]?.path.startsWith(planAttachmentDirectory(roleDir, plan.id, "active")), true);
  assert.equal(listPlanHistory(roleDir, plan.id)[0]?.after.attachments[0]?.path.startsWith(planAttachmentDirectory(roleDir, plan.id, "active")), true);
  assert.equal(listPlanFeedback(roleDir, plan.id)[0]?.attachments[0]?.path.startsWith(planFeedbackAttachmentDirectory(roleDir, plan.id, "legacy-feedback", "active")), true);
  assert.deepEqual(migrateRolePlanLayout(roleDir), { migrated: 0, skipped: 0, failures: [] });

  updatePlan(roleDir, plan.id, {
    status: "已归档",
    currentStepId: "",
    steps: [{ id: "move", title: "Move plan", status: "已完成" }]
  });
  assert.equal(fs.existsSync(planDirectory(roleDir, plan.id, "active")), false);
  assert.equal(fs.existsSync(planJsonFile(roleDir, plan.id, "archive")), true);
  assert.equal(fs.existsSync(planAttachmentDirectory(roleDir, plan.id, "archive")), true);
  assert.equal(fs.existsSync(planFeedbackAttachmentDirectory(roleDir, plan.id, "legacy-feedback", "archive")), true);
  assert.equal(listPlanHistory(roleDir, plan.id).at(-1)?.kind, "archived");
});

test("plan writes reject presentation-only lifecycle labels as top-level status", () => {
  const roleDir = makeRoleDir();
  assert.throws(() => createPlan(roleDir, {
    id: "invalid-lifecycle-status",
    title: "Invalid lifecycle status",
    focus: "Reject presentation-only lifecycle labels",
    status: "等待打包",
    currentStepId: "package",
    steps: [{ id: "package", title: "等待打包", status: "进行中" }],
    keywords: ["lifecycle"]
  }), /Unsupported plan status/);

  const created = createPlan(roleDir, {
    id: "valid-lifecycle-status",
    title: "Valid lifecycle status",
    focus: "Keep the stored lifecycle status supported",
    status: "进行中",
    currentStepId: "package",
    steps: [{ id: "package", title: "等待打包", status: "进行中" }],
    keywords: ["lifecycle"]
  });
  assert.throws(() => updatePlan(roleDir, created.id, { status: "等待 QA 验收" }), /Unsupported plan status/);
  assert.equal(getPlan(roleDir, created.id)?.status, "进行中");
});

test("cold plan catalogs load asynchronously and share one in-flight cache fill", async () => {
  const roleDir = makeRoleDir();
  for (let index = 0; index < 80; index += 1) {
    createPlan(roleDir, {
      id: `async-plan-${String(index).padStart(3, "0")}`,
      title: `异步计划 ${index}`,
      focus: `验证异步目录 ${index}`,
      steps: [{ id: "load", title: "加载", status: "未开始" }],
      keywords: ["异步目录"]
    });
  }
  const originalReadFile = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
    reads += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return originalReadFile(...args as [path: fs.PathLike, options: BufferEncoding]);
  }) as typeof fs.promises.readFile;
  try {
    let eventLoopYielded = false;
    setImmediate(() => { eventLoopYielded = true; });
    const [first, second] = await Promise.all([listPlansAsync(roleDir), listPlansAsync(roleDir)]);
    assert.equal(eventLoopYielded, true);
    assert.equal(first.length, 80);
    assert.equal(second, first);
    assert.equal(reads >= 80 && reads < 160, true);
    const coldReads = reads;
    assert.equal(await listPlansAsync(roleDir), first);
    assert.equal(reads, coldReads);
  } finally {
    fs.promises.readFile = originalReadFile;
  }
});

test("an async plan catalog retries when a canonical write invalidates the in-flight snapshot", async () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    id: "async-invalidation-plan",
    title: "写入前标题",
    focus: "验证异步缓存失效",
    steps: [{ id: "load", title: "加载", status: "未开始" }],
    keywords: ["异步缓存失效"]
  });
  const originalReadFile = fs.promises.readFile;
  let releaseFirstRead: (() => void) | undefined;
  let firstReadStartedResolve!: () => void;
  const firstReadStarted = new Promise<void>((resolve) => { firstReadStartedResolve = resolve; });
  let firstRead = true;
  fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
    const result = await originalReadFile(...args as [path: fs.PathLike, options: BufferEncoding]);
    if (firstRead) {
      firstRead = false;
      firstReadStartedResolve();
      await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    }
    return result;
  }) as typeof fs.promises.readFile;
  try {
    const loading = listPlansAsync(roleDir);
    await firstReadStarted;
    updatePlan(roleDir, plan.id, { title: "写入后标题" });
    releaseFirstRead?.();
    const loaded = await loading;
    assert.equal(loaded.find((item) => item.id === plan.id)?.title, "写入后标题");
  } finally {
    fs.promises.readFile = originalReadFile;
  }
});

test("new memories use Markdown files while legacy JSON remains readable without duplication", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "legacy-memory",
    title: "Legacy memory",
    focus: "Legacy compatibility",
    content: "Legacy JSON content",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["legacy"]
  });

  const created = createRecentMemory(roleDir, {
    id: "markdown-memory",
    title: "Markdown memory",
    focus: "Markdown storage",
    content: "## Evidence\n\n![diagram](https://example.com/memory.png)\n\n- Stable fact",
    source: { kind: "conversation", summary: "Memory source" },
    keywords: ["markdown", "image"]
  });
  const markdownPath = path.join(roleDir, "memory", "recent", `${created.id}.md`);
  assert.equal(fs.existsSync(markdownPath), true);
  assert.equal(fs.existsSync(path.join(roleDir, "memory", "recent", `${created.id}.json`)), false);
  const source = fs.readFileSync(markdownPath, "utf8");
  assert.match(source, /^---\r?\n/);
  assert.match(source, /title: "Markdown memory"/);
  assert.match(source, /## Evidence/);
  assert.match(source, /!\[diagram\]\(https:\/\/example\.com\/memory\.png\)/);

  fs.writeFileSync(path.join(roleDir, "memory", "recent", `${created.id}.json`), JSON.stringify({
    ...created,
    title: "Stale JSON duplicate",
    content: "This duplicate must lose to Markdown."
  }), "utf8");
  const memories = listRecentMemories(roleDir);
  assert.equal(memories.length, 2);
  assert.equal(memories.find((memory) => memory.id === created.id)?.title, "Markdown memory");
  assert.equal(memories.find((memory) => memory.id === "legacy-memory")?.content, "Legacy JSON content");
});

test("canonical plan updates publish one event after persistence", () => {
  const roleDir = makeRoleDir();
  const created = createPlan(roleDir, {
    id: "plan-update-event",
    title: "Plan update event",
    focus: "Notify Manager after the canonical plan write",
    status: "进行中",
    currentStepId: "work",
    steps: [{ id: "work", title: "Work", status: "进行中" }],
    keywords: ["event"]
  });
  const events: Array<{ roleDir: string; beforeTitle: string; afterTitle: string; persistedTitle?: string }> = [];
  const unsubscribe = subscribePlanUpdates((event) => {
    events.push({
      roleDir: event.roleDir,
      beforeTitle: event.before.title,
      afterTitle: event.after.title,
      persistedTitle: getPlan(event.roleDir, event.after.id)?.title
    });
  });
  try {
    updatePlan(roleDir, created.id, { title: "Updated through canonical writer" });
  } finally {
    unsubscribe();
  }
  assert.deepEqual(events, [{
    roleDir: path.resolve(roleDir),
    beforeTitle: "Plan update event",
    afterTitle: "Updated through canonical writer",
    persistedTitle: "Updated through canonical writer"
  }]);
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

  const filePath = planJsonFile(roleDir, created.id, "active");
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

test("memory catalogs reuse unchanged reads and observe direct external file changes", async () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-cache-one",
    title: "Memory cache one",
    focus: "Cache memory reads",
    content: "First memory",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    keywords: ["cache"]
  });
  writeConsolidatedMemory(roleDir, {
    id: "consolidated-cache-one",
    title: "Consolidated cache one",
    focus: "Cache consolidated memory reads",
    content: "First consolidated memory",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    keywords: ["cache"]
  });

  const firstRecent = listRecentMemories(roleDir);
  const firstConsolidated = listConsolidatedMemories(roleDir);
  assert.equal(listRecentMemories(roleDir), firstRecent);
  assert.equal(listConsolidatedMemories(roleDir), firstConsolidated);

  writeRecentMemory(roleDir, {
    id: "memory-cache-two",
    title: "Memory cache two",
    focus: "Observe external memory writes",
    content: "Second memory",
    createdAt: "2026-08-06T00:01:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
    keywords: ["cache"]
  });

  let refreshed = firstRecent;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    refreshed = listRecentMemories(roleDir);
    if (refreshed.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(refreshed.length, 2);
  assert.notEqual(refreshed, firstRecent);
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
  const changedFile = planJsonFile(roleDir, changedId, "active");
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

test("plan detail reads reuse the warm plan list cache", { concurrency: false }, () => {
  const roleDir = makeRoleDir();
  for (let index = 0; index < 8; index += 1) {
    createPlan(roleDir, {
      id: `detail-cache-${index}`,
      title: `Detail cache ${index}`,
      focus: `Reuse the warm catalog for detail ${index}`,
      status: "进行中",
      currentStepId: "inspect",
      steps: [{ id: "inspect", title: "Inspect", status: "进行中" }],
      keywords: ["cache", "detail"]
    });
  }
  const plans = listPlans(roleDir);
  const originalReadFileSync = fs.readFileSync;
  let planFileReads = 0;
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof filePath === "string" && filePath.includes(`${path.sep}plans${path.sep}`) && filePath.endsWith(".json")) {
      planFileReads += 1;
    }
    return (originalReadFileSync as (...callArgs: unknown[]) => unknown)(filePath, ...args);
  }) as typeof fs.readFileSync;
  try {
    for (const plan of plans) assert.equal(getPlan(roleDir, plan.id)?.id, plan.id);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(planFileReads, 0);
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
  assert.equal(path.relative(planAttachmentDirectory(roleDir, plan.id, "active"), plan.attachments[0]!.path).startsWith(".."), false);
  const stored = fs.readFileSync(planJsonFile(roleDir, plan.id, "active"), "utf8");
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
  return listRecentMemories(roleDir).find((memory) => memory.id === id) as unknown as Record<string, unknown>;
}

function readConsolidatedMemory(roleDir: string, id: string): Record<string, unknown> {
  return listConsolidatedMemories(roleDir).find((memory) => memory.id === id) as unknown as Record<string, unknown>;
}

test("keyword recall records recalledAt and delays consolidation", () => {
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
  assert.equal(touched.recalledAt, touched.viewedAt);
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
  assert.equal(read?.recalledAt, undefined);

  const updated = updateRecentMemory(roleDir, "memory-read", { content: "新内容" });
  assert.equal(updated.content, "新内容");
  assert.equal(updated.viewedAt, updated.updatedAt);
  assert.equal(updated.recalledAt, undefined);
});

test("memory lifecycle presentation exposes Manager-owned 24 and 72 hour boundaries", () => {
  const memory = {
    id: "memory-lifecycle",
    title: "生命周期",
    focus: "显示近期记忆生命周期",
    content: "生命周期内容",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    viewedAt: "2026-08-01T10:00:00.000Z",
    recalledAt: "2026-08-01T06:00:00.000Z",
    keywords: ["生命周期"]
  };
  const active = presentRoleMemory(memory, "recent", Date.parse("2026-08-02T05:59:59.000Z"));
  assert.equal(active.lifecycle.activityAt, memory.recalledAt);
  assert.equal(active.lifecycle.consolidationEligibleAt, "2026-08-02T06:00:00.000Z");
  assert.equal(active.lifecycle.consolidationTriggerAt, "2026-08-04T06:00:00.000Z");
  assert.equal(active.lifecycle.state, "active");

  const eligible = presentRoleMemory(memory, "recent", Date.parse("2026-08-03T12:00:00.000Z"));
  assert.equal(eligible.lifecycle.state, "eligible");
  const due = presentRoleMemory(memory, "recent", Date.parse("2026-08-04T06:00:00.000Z"));
  assert.equal(due.lifecycle.state, "trigger_due");
});

test("Manager projects the next consolidation trigger and cached candidate booleans from recall activity", () => {
  const roleDir = makeRoleDir();
  const memories = [
    {
      id: "memory-trigger",
      title: "最不活跃",
      focus: "触发下一次沉淀",
      content: "最早到达 72 小时",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      recalledAt: "2026-08-01T06:00:00.000Z",
      viewedAt: "2026-08-03T00:00:00.000Z",
      keywords: ["触发"]
    },
    {
      id: "memory-enters",
      title: "会进入",
      focus: "届时超过 24 小时",
      content: "预计进入同一次沉淀",
      createdAt: "2026-08-02T05:00:00.000Z",
      updatedAt: "2026-08-02T05:00:00.000Z",
      keywords: ["进入"]
    },
    {
      id: "memory-stays",
      title: "暂不进入",
      focus: "届时不足 24 小时",
      content: "不会进入同一次沉淀",
      createdAt: "2026-08-03T07:00:00.000Z",
      updatedAt: "2026-08-03T07:00:00.000Z",
      keywords: ["暂不进入"]
    }
  ];

  const presented = presentRoleMemories(roleDir, memories, "recent", Date.parse("2026-08-03T12:00:00.000Z"));
  const trigger = presented.find((memory) => memory.id === "memory-trigger");
  assert.equal(trigger?.lifecycle.activityAt, "2026-08-01T06:00:00.000Z");
  assert.equal(trigger?.lifecycle.triggersNextConsolidation, true);
  assert.equal(trigger?.lifecycle.willEnterNextConsolidation, true);
  assert.equal(presented.find((memory) => memory.id === "memory-enters")?.lifecycle.willEnterNextConsolidation, true);
  assert.equal(presented.find((memory) => memory.id === "memory-stays")?.lifecycle.willEnterNextConsolidation, false);
});

test("Manager exposes the exact next consolidation deadline for automatic scheduling", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-deadline",
    title: "自动沉淀截止时间",
    focus: "Manager 安排下一次沉淀",
    content: "到达 72 小时后自动触发。",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    recalledAt: "2026-08-01T06:00:00.000Z",
    keywords: ["自动沉淀"]
  });

  assert.equal(
    nextMemoryConsolidationTriggerAt(roleDir),
    Date.parse("2026-08-04T06:00:00.000Z")
  );
});

test("an overdue consolidation keeps the candidate ceiling from its original 72-hour trigger", () => {
  const roleDir = makeRoleDir();
  const now = Date.now();
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  for (const memory of [
    {
      id: "memory-trigger",
      title: "最早触发记忆",
      focus: "固定逾期批次触发时刻",
      content: "这条记忆在一百小时前停止活跃。",
      createdAt: hoursAgo(100),
      updatedAt: hoursAgo(100),
      keywords: ["触发"]
    },
    {
      id: "memory-original-candidate",
      title: "原批次候选",
      focus: "在原触发时刻已经超过二十四小时",
      content: "这条记忆在六十小时前停止活跃。",
      createdAt: hoursAgo(60),
      updatedAt: hoursAgo(60),
      keywords: ["原候选"]
    },
    {
      id: "memory-late-candidate",
      title: "后来才变旧",
      focus: "执行延迟期间不得补入旧批次",
      content: "现在已经超过二十四小时，但原触发时刻还没有。",
      createdAt: hoursAgo(30),
      updatedAt: hoursAgo(30),
      keywords: ["后到"]
    }
  ]) {
    writeRecentMemory(roleDir, memory);
  }

  const request = pendingMemoryConsolidation(roleDir, "api", 24, 72, false);
  assert.ok(request);
  assert.deepEqual(request.memories.map((memory) => memory.id).sort(), [
    "memory-original-candidate",
    "memory-trigger"
  ]);
  assert.deepEqual(request.run.inputMemoryIds, [
    "memory-original-candidate",
    "memory-trigger"
  ]);
  const delivered = markMemoryConsolidationRunDelivered(roleDir, request.run.id, "2026-08-07T10:00:00.000Z");
  assert.equal(delivered.deliveredAt, "2026-08-07T10:00:00.000Z");
  assert.equal(pendingMemoryConsolidation(roleDir, "auto")?.run.deliveredAt, delivered.deliveredAt);
});

test("memory writes invalidate the cached consolidation projection while a direct read does not change its trigger", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-oldest",
    title: "原最不活跃记忆",
    focus: "验证沉淀投影缓存失效",
    content: "最初先到达 72 小时",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["缓存失效"]
  });
  writeRecentMemory(roleDir, {
    id: "memory-second",
    title: "第二不活跃记忆",
    focus: "验证沉淀投影缓存失效",
    content: "更新第一条后成为触发项",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    keywords: ["缓存失效"]
  });

  const triggerId = () => presentRoleMemories(roleDir, listRecentMemories(roleDir), "recent")
    .find((memory) => memory.lifecycle.triggersNextConsolidation)?.id;
  assert.equal(triggerId(), "memory-oldest");

  getRecentMemory(roleDir, "memory-oldest");
  assert.equal(triggerId(), "memory-oldest");

  updateRecentMemory(roleDir, "memory-oldest", { content: "已更新并重新计算沉淀时间" });
  assert.equal(triggerId(), "memory-second");
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
  assert.equal(touched.recalledAt, touched.viewedAt);
});

test("consolidated sources are not consolidated again while consolidated output remains recallable", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-source",
    title: "已沉淀来源",
    focus: "已完成沉淀的来源记忆",
    content: "来源内容",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    consolidatedAt: "2026-01-05T00:00:00.000Z",
    consolidationRunId: "run-completed",
    keywords: ["稳定结论"]
  });
  writeConsolidatedMemory(roleDir, {
    id: "memory-output",
    title: "已沉淀结论",
    focus: "可继续召回的沉淀结论",
    content: "沉淀后的稳定内容",
    createdAt: "2026-01-05T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    inputMemoryIds: ["memory-source"],
    consolidationRunId: "run-completed",
    keywords: ["稳定结论"]
  });

  assert.equal(pendingMemoryConsolidation(roleDir, "api", 24, 72, true), null);
  const snapshot = roleKnowledgeSnapshot(roleDir, "请读取稳定结论");
  assert.equal(snapshot.requiredReadItems.some((item) => item.id === "memory-source"), false);
  assert.equal(snapshot.requiredReadItems.some((item) => item.id === "memory-output" && item.type === "consolidated_memory"), true);
  const recalled = readConsolidatedMemory(roleDir, "memory-output");
  assert.equal(typeof recalled.recalledAt, "string");
});

test("memory catalogs expose recent, consolidated, and archived memories as separate categories", () => {
  const roleDir = makeRoleDir();
  writeRecentMemory(roleDir, {
    id: "memory-active-category",
    title: "仍属近期",
    focus: "近期记忆分类",
    content: "尚未沉淀。",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["分类"]
  });
  writeRecentMemory(roleDir, {
    id: "memory-archived-category",
    title: "已归档来源",
    focus: "归档记忆分类",
    content: "已经进入沉淀流程。",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    consolidatedAt: "2026-08-02T00:00:00.000Z",
    consolidationRunId: "run-category",
    keywords: ["分类"]
  });
  writeConsolidatedMemory(roleDir, {
    id: "memory-consolidated-category",
    title: "沉淀记忆",
    focus: "沉淀记忆分类",
    content: "整理后的稳定结论。",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    inputMemoryIds: ["memory-archived-category"],
    consolidationRunId: "run-category",
    keywords: ["分类"]
  });

  assert.deepEqual(listActiveRecentMemories(roleDir).map((memory) => memory.id), ["memory-active-category"]);
  assert.deepEqual(listArchivedMemories(roleDir).map((memory) => memory.id), ["memory-archived-category"]);
  assert.deepEqual(listConsolidatedMemories(roleDir).map((memory) => memory.id), ["memory-consolidated-category"]);
  assert.deepEqual(roleMemoryCounts(roleDir), {
    recent: 1,
    consolidated: 1,
    archived: 1,
    consolidationRuns: 0
  });
});

test("large consolidation writes yield to the Manager event loop", async () => {
  const roleDir = makeRoleDir();
  for (let index = 0; index < 48; index += 1) {
    writeRecentMemory(roleDir, {
      id: `memory-batch-${index}`,
      title: `批量记忆 ${index}`,
      focus: `批量沉淀主题 ${index}`,
      content: `需要沉淀的内容 ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      keywords: ["批量沉淀"]
    });
  }

  const request = pendingMemoryConsolidation(roleDir, "api", 24, 72, true);
  assert.ok(request);

  let managerTurnRan = false;
  setTimeout(() => {
    managerTurnRan = true;
  }, 0);

  const completion = completeMemoryConsolidation(roleDir, request.run.id, [{
    id: "memory-batch-output",
    title: "批量沉淀结果",
    focus: "验证批量写入不会阻塞 Manager",
    content: "批量记忆已经整理完成。",
    inputMemoryIds: request.run.inputMemoryIds,
    keywords: ["批量沉淀"]
  }]);
  const duplicateCompletion = completeMemoryConsolidation(roleDir, request.run.id, []);
  assert.equal(duplicateCompletion, completion);
  const result = await completion;

  assert.equal(managerTurnRan, true);
  assert.equal(result.run.status, "completed");
  assert.equal(
    listRecentMemories(roleDir).filter((memory) => memory.consolidationRunId === request.run.id).length,
    48
  );
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

test("paused plans require exactly one preserved resume step", () => {
  const roleDir = makeRoleDir();

  assert.throws(() => createPlan(roleDir, {
    title: "缺少恢复点的暂停计划",
    focus: "缺少恢复点的暂停计划",
    status: "暂停",
    currentStep: "暂停但没有结构化恢复位置",
    steps: [
      { id: "inspect", title: "检查现状", status: "已完成" },
      { id: "implement", title: "继续实现", status: "未开始" }
    ],
    keywords: ["暂停"]
  }), /paused plan must preserve currentStepId/i);
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

test("plans persist the responsible secretary separately from the business task binding", () => {
  const roleDir = makeRoleDir();
  const plan = createPlan(roleDir, {
    title: "秘书与业务任务分离",
    focus: "秘书与业务任务分离",
    status: "未开始",
    steps: [{ id: "run", title: "运行绑定任务", status: "未开始" }],
    secretaryBinding: {
      agentType: "codex",
      sessionId: "session-plan-secretary",
      sessionTitle: "主人格 协助处理计划1",
      workspace: "C:\\workspace\\route",
      assignedAt: "2026-08-06T00:00:00.000Z"
    },
    taskBinding: {
      agentType: "codex",
      sessionId: "session-plan-worker",
      sessionTitle: "计划执行任务",
      workspace: "C:\\workspace\\project"
    },
    keywords: ["会话任务"]
  });

  assert.equal(plan.secretaryBinding?.sessionId, "session-plan-secretary");
  assert.equal(plan.taskBinding?.sessionId, "session-plan-worker");
  assert.notEqual(plan.secretaryBinding?.sessionId, plan.taskBinding?.sessionId);
  assert.throws(() => updatePlan(roleDir, plan.id, {
    secretaryBinding: { agentType: "codex", sessionId: "missing-workspace" }
  }), /secretaryBinding\.workspace is required/);
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
