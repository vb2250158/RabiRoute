import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type PlanStatus = "未开始" | "进行中" | "已完成" | "已归档";
export type PlanStepStatus = "未开始" | "进行中" | "已完成";

export type PlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  detail?: string;
  waitingFor?: string;
  blockedBy?: string;
  completedAt?: string;
};

export type KnowledgeSource = {
  kind?: string;
  summary?: string;
};

export type PlanItem = {
  id: string;
  title: string;
  focus: string;
  status: PlanStatus;
  priority?: string;
  kind?: string;
  currentStep?: string;
  currentStepId?: string;
  nextAction?: string;
  waitingFor?: string;
  blockedBy?: string;
  steps: PlanStep[];
  project?: {
    name?: string;
    path?: string;
  };
  source?: KnowledgeSource;
  dueAt?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
};

export type RecentMemoryItem = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  consolidatedAt?: string;
  consolidationRunId?: string;
  keywords: string[];
};

export type ConsolidatedMemoryItem = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  inputMemoryIds?: string[];
  consolidationRunId?: string;
  keywords: string[];
};

export type RoleSkillStatus = "active" | "draft" | "archived";

export type RoleSkillItem = {
  id: string;
  title: string;
  summary: string;
  source?: KnowledgeSource;
  updatedAt: string;
  status: RoleSkillStatus;
  keywords: string[];
  path: string;
};

export type RoleSkillDetail = RoleSkillItem & {
  content: string;
};

export type MemoryConsolidationRun = {
  id: string;
  roleDir: string;
  requestedAt: string;
  completedAt?: string;
  trigger: "auto" | "manual" | "api";
  recentEditableHours: number;
  recentConsolidationHours: number;
  inputMemoryIds: string[];
  outputMemoryIds?: string[];
  status: "requested" | "completed";
  instruction: string;
};

export type MemoryConsolidationRequest = {
  run: MemoryConsolidationRun;
  memories: RecentMemoryItem[];
};

export type RoleKnowledgeItemType = "plan" | "recent_memory" | "consolidated_memory" | "role_skill";

export type RoleKnowledgeIndexItem = {
  id: string;
  title: string;
  type: RoleKnowledgeItemType;
};

export type RequiredReadItem = RoleKnowledgeIndexItem & {
  endpoint: string;
  score: number;
};

export type CreateMemoryConsolidationRequestOptions = {
  roleId?: string;
  triggerSource?: "auto" | "manual" | "api";
  triggerOlderThanHours?: number;
  includeOlderThanHours?: number;
  force?: boolean;
};

export type RoleKnowledgeSnapshot = {
  roleDir: string;
  plansDir: string;
  memoryDir: string;
  agentInterfaceDocPath: string;
  activePlans: PlanItem[];
  activeSkills: RoleSkillItem[];
  recentMemories: RecentMemoryItem[];
  matchedItems: RoleKnowledgeIndexItem[];
  matchedSkills: RoleSkillItem[];
  requiredReadItems: RequiredReadItem[];
  pendingConsolidation?: MemoryConsolidationRequest;
};

export type RoleKnowledgeSnapshotOptions = {
  roleId?: string;
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
  forceConsolidation?: boolean;
  requiredReadLimit?: number;
};

export const DEFAULT_PLAN_ARCHIVE_AFTER_HOURS = 72;
export const DEFAULT_RECENT_EDITABLE_HOURS = 24;
export const DEFAULT_RECENT_CONSOLIDATION_HOURS = 72;

export type PlanWriteLimits = {
  titleChars: number;
  focusChars: number;
  currentStepChars: number;
  stepTitleChars: number;
  stepDetailChars: number;
  stepWaitingForChars: number;
  stepBlockedByChars: number;
  maxSteps: number;
  nextActionChars: number;
  waitingForChars: number;
  blockedByChars: number;
  sourceSummaryChars: number;
  keywordChars: number;
  maxKeywords: number;
  totalChars: number;
};

export type MemoryWriteLimits = {
  titleChars: number;
  focusChars: number;
  contentChars: number;
  sourceSummaryChars: number;
  keywordChars: number;
  maxKeywords: number;
  totalChars: number;
};

export type RoleKnowledgeWriteLimits = {
  plan: PlanWriteLimits;
  memory: MemoryWriteLimits;
};

export const DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS: RoleKnowledgeWriteLimits = {
  plan: {
    titleChars: 80,
    focusChars: 80,
    currentStepChars: 1200,
    stepTitleChars: 120,
    stepDetailChars: 600,
    stepWaitingForChars: 300,
    stepBlockedByChars: 300,
    maxSteps: 100,
    nextActionChars: 600,
    waitingForChars: 300,
    blockedByChars: 600,
    sourceSummaryChars: 240,
    keywordChars: 32,
    maxKeywords: 24,
    totalChars: 2800
  },
  memory: {
    titleChars: 80,
    focusChars: 80,
    contentChars: 4000,
    sourceSummaryChars: 240,
    keywordChars: 32,
    maxKeywords: 24,
    totalChars: 4600
  }
};

export type RoleKnowledgeValidationIssue = {
  type: "plan" | "recent_memory" | "consolidated_memory";
  id: string;
  message: string;
};

export type RoleKnowledgeValidationResult = {
  ok: boolean;
  limits: RoleKnowledgeWriteLimits;
  issues: RoleKnowledgeValidationIssue[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

function generatedId(prefix: string, title: string): string {
  const suffix = safeIdPart(title) || Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${suffix}`;
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function jsonFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function markdownFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function ageHours(updatedAt: string, now = Date.now()): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now - parsed) / 3_600_000);
}

function laterIso(left?: string, right?: string): string {
  const leftMs = Date.parse(left || "");
  const rightMs = Date.parse(right || "");
  if (!Number.isFinite(leftMs)) return right || left || nowIso();
  if (!Number.isFinite(rightMs)) return left || right || nowIso();
  return rightMs > leftMs ? right as string : left as string;
}

function memoryActivityAt(memory: { updatedAt: string; viewedAt?: string }): string {
  return laterIso(memory.updatedAt, memory.viewedAt);
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseKeywordValue(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeKeywords(value);
  const text = String(value || "").trim();
  if (!text) return [];
  const inner = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return normalizeKeywords(inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")));
}

function requireKeywords(keywords: string[], label: string): void {
  if (keywords.length === 0) {
    throw new Error(`${label} keywords are required.`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(100_000, Math.floor(parsed));
}

function mergeLimits<T extends Record<string, number>>(defaults: T, raw: unknown): T {
  const source = recordValue(raw);
  const output = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    output[key] = positiveLimit(source[String(key)], defaults[key]) as T[keyof T];
  }
  return output;
}

export function roleKnowledgeWriteLimits(roleDir: string): RoleKnowledgeWriteLimits {
  const config = readJson<Record<string, unknown>>(path.join(roleDir, "personaConfig.json")) ?? {};
  const knowledgeLimits = recordValue(config.knowledgeLimits);
  return {
    plan: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.plan, knowledgeLimits.plan),
    memory: mergeLimits(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS.memory, knowledgeLimits.memory)
  };
}

function textChars(value: unknown): number {
  return Array.from(String(value || "")).length;
}

function assertTextLimit(label: string, value: unknown, maximum: number): void {
  const actual = textChars(value);
  if (actual > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters (received ${actual}). Split it into focused items.`);
  }
}

function assertSingleFocus(label: string, focus: string, maximum: number): void {
  if (!focus.trim()) throw new Error(`${label} focus is required.`);
  if (/\r|\n/.test(focus)) throw new Error(`${label} focus must be a single line and describe one subject.`);
  assertTextLimit(`${label} focus`, focus, maximum);
}

function assertKeywordLimits(label: string, keywords: string[], maximumItems: number, maximumChars: number): void {
  if (keywords.length > maximumItems) {
    throw new Error(`${label} has ${keywords.length} keywords; maximum is ${maximumItems}. Keep one focused subject.`);
  }
  for (const keyword of keywords) {
    assertTextLimit(`${label} keyword`, keyword, maximumChars);
  }
}

function planTextTotal(plan: PlanItem): number {
  return [
    plan.title,
    plan.focus,
    plan.currentStep,
    plan.currentStepId,
    plan.nextAction,
    plan.waitingFor,
    plan.blockedBy,
    plan.project?.name,
    plan.project?.path,
    plan.source?.kind,
    plan.source?.summary,
    ...plan.steps.flatMap((step) => [step.id, step.title, step.detail, step.waitingFor, step.blockedBy, step.completedAt]),
    ...plan.keywords
  ].reduce((total, value) => total + textChars(value), 0);
}

function memoryTextTotal(memory: RecentMemoryItem | ConsolidatedMemoryItem): number {
  return [
    memory.title,
    memory.focus,
    memory.content,
    memory.source?.kind,
    memory.source?.summary,
    ...memory.keywords
  ].reduce((total, value) => total + textChars(value), 0);
}

function validatePlanSteps(plan: PlanItem, limits: PlanWriteLimits, requireSteps: boolean): void {
  if (requireSteps && plan.steps.length === 0) {
    throw new Error("Plan steps are required. List every ordered step and identify the current step when work is in progress.");
  }
  if (plan.steps.length > limits.maxSteps) {
    throw new Error(`Plan has ${plan.steps.length} steps; maximum is ${limits.maxSteps}. Split the plan into focused plans.`);
  }

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id.trim()) throw new Error("Plan step id is required.");
    if (ids.has(step.id)) throw new Error(`Plan step id must be unique: ${step.id}`);
    ids.add(step.id);
    assertTextLimit("Plan step id", step.id, 80);
    assertTextLimit("Plan step title", step.title, limits.stepTitleChars);
    assertTextLimit("Plan step detail", step.detail, limits.stepDetailChars);
    assertTextLimit("Plan step waitingFor", step.waitingFor, limits.stepWaitingForChars);
    assertTextLimit("Plan step blockedBy", step.blockedBy, limits.stepBlockedByChars);
  }

  const currentSteps = plan.steps.filter((step) => step.status === "进行中");
  if (currentSteps.length > 1) throw new Error("Plan can have only one in-progress step.");
  if (plan.currentStepId && !ids.has(plan.currentStepId)) {
    throw new Error(`Plan currentStepId does not match a step: ${plan.currentStepId}`);
  }
  if (plan.steps.length > 0 && plan.status === "进行中") {
    if (!plan.currentStepId) throw new Error("An in-progress plan must provide currentStepId.");
    if (currentSteps.length !== 1 || currentSteps[0]?.id !== plan.currentStepId) {
      throw new Error("Plan currentStepId must identify the only step whose status is 进行中.");
    }
  }
  if (plan.status !== "进行中" && plan.currentStepId) {
    throw new Error("Only an in-progress plan can provide currentStepId.");
  }
  if (plan.status === "未开始" && currentSteps.length > 0) {
    throw new Error("A not-started plan cannot contain an in-progress step.");
  }
  if (plan.steps.length > 0 && (plan.status === "已完成" || plan.status === "已归档")) {
    if (plan.steps.some((step) => step.status !== "已完成")) {
      throw new Error("Every plan step must be completed before the plan can be completed or archived.");
    }
  }
}

function validatePlanWrite(roleDir: string, plan: PlanItem, requireSteps = false): void {
  const limits = roleKnowledgeWriteLimits(roleDir).plan;
  assertTextLimit("Plan title", plan.title, limits.titleChars);
  assertSingleFocus("Plan", plan.focus, limits.focusChars);
  assertTextLimit("Plan currentStep", plan.currentStep, limits.currentStepChars);
  assertTextLimit("Plan nextAction", plan.nextAction, limits.nextActionChars);
  assertTextLimit("Plan waitingFor", plan.waitingFor, limits.waitingForChars);
  assertTextLimit("Plan blockedBy", plan.blockedBy, limits.blockedByChars);
  assertTextLimit("Plan source.summary", plan.source?.summary, limits.sourceSummaryChars);
  assertKeywordLimits("Plan", plan.keywords, limits.maxKeywords, limits.keywordChars);
  validatePlanSteps(plan, limits, requireSteps);
  const total = planTextTotal(plan);
  if (total > limits.totalChars) {
    throw new Error(`Plan text exceeds ${limits.totalChars} characters in total (received ${total}). Split it into one plan per subject.`);
  }
}

function validateMemoryWrite(roleDir: string, memory: RecentMemoryItem | ConsolidatedMemoryItem, label = "Memory"): void {
  const limits = roleKnowledgeWriteLimits(roleDir).memory;
  assertTextLimit(`${label} title`, memory.title, limits.titleChars);
  assertSingleFocus(label, memory.focus, limits.focusChars);
  assertTextLimit(`${label} content`, memory.content, limits.contentChars);
  assertTextLimit(`${label} source.summary`, memory.source?.summary, limits.sourceSummaryChars);
  assertKeywordLimits(label, memory.keywords, limits.maxKeywords, limits.keywordChars);
  const total = memoryTextTotal(memory);
  if (total > limits.totalChars) {
    throw new Error(`${label} text exceeds ${limits.totalChars} characters in total (received ${total}). Split it into one memory per subject.`);
  }
}

function normalizePlanSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<PlanStep>((rawStep, index) => {
    if (typeof rawStep === "string") {
      const title = rawStep.trim();
      return title ? [{ id: `step-${index + 1}`, title, status: "未开始" }] : [];
    }
    const raw = recordValue(rawStep);
    const title = String(raw.title || raw.name || raw.label || "").trim();
    if (!title) return [];
    const rawStatus = String(raw.status || "").trim();
    const status: PlanStepStatus = rawStatus === "已完成" || raw.completed === true
      ? "已完成"
      : rawStatus === "进行中" || raw.current === true
        ? "进行中"
        : "未开始";
    return [{
      id: String(raw.id || raw.stepId || `step-${index + 1}`).trim(),
      title,
      status,
      detail: typeof raw.detail === "string" ? raw.detail : typeof raw.description === "string" ? raw.description : undefined,
      waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
      blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined
    }];
  });
}

function normalizePlan(raw: Partial<PlanItem> & Record<string, unknown>, fallbackId?: string): PlanItem | null {
  const title = String(raw.title || "").trim();
  if (!title) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  const status: PlanStatus = raw.status === "未开始" || raw.status === "进行中" || raw.status === "已完成" || raw.status === "已归档"
    ? raw.status
    : "未开始";
  return {
    id: String(raw.id || fallbackId || generatedId("plan", title)),
    title,
    focus: String(raw.focus || title).trim(),
    status,
    priority: typeof raw.priority === "string" ? raw.priority : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    currentStep: typeof raw.currentStep === "string" ? raw.currentStep : undefined,
    currentStepId: typeof raw.currentStepId === "string" ? raw.currentStepId : undefined,
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction : undefined,
    waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
    blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
    steps: normalizePlanSteps(raw.steps),
    project: raw.project && typeof raw.project === "object" && !Array.isArray(raw.project) ? raw.project as PlanItem["project"] : undefined,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    dueAt: typeof raw.dueAt === "string" ? raw.dueAt : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function normalizeRecentMemory(raw: Partial<RecentMemoryItem> & Record<string, unknown>, fallbackId?: string): RecentMemoryItem | null {
  const title = String(raw.title || "").trim();
  const content = String(raw.content || "").trim();
  if (!title || !content) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  return {
    id: String(raw.id || fallbackId || generatedId("memory", title)),
    title,
    focus: String(raw.focus || title).trim(),
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    viewedAt: typeof raw.viewedAt === "string" ? raw.viewedAt : undefined,
    consolidatedAt: typeof raw.consolidatedAt === "string" ? raw.consolidatedAt : undefined,
    consolidationRunId: typeof raw.consolidationRunId === "string" ? raw.consolidationRunId : undefined,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function normalizeConsolidatedMemory(raw: Partial<ConsolidatedMemoryItem> & Record<string, unknown>, fallbackId?: string): ConsolidatedMemoryItem | null {
  const title = String(raw.title || "").trim();
  const content = String(raw.content || "").trim();
  if (!title || !content) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  return {
    id: String(raw.id || fallbackId || generatedId("consolidated-memory", title)),
    title,
    focus: String(raw.focus || title).trim(),
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    viewedAt: typeof raw.viewedAt === "string" ? raw.viewedAt : undefined,
    inputMemoryIds: Array.isArray(raw.inputMemoryIds) ? raw.inputMemoryIds.map(String) : undefined,
    consolidationRunId: typeof raw.consolidationRunId === "string" ? raw.consolidationRunId : undefined,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function parseSkillMarkdown(filePath: string): RoleSkillDetail | null {
  const raw = fs.readFileSync(filePath, "utf8");
  const metadata: Record<string, string> = {};
  let content = raw.trim();
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatter) {
    content = raw.slice(frontmatter[0].length).trim();
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (pair) {
        metadata[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  const fallbackId = path.basename(filePath, ".md");
  const title = String(metadata.title || content.match(/^#\s+(.+)$/m)?.[1] || fallbackId).trim();
  const summary = String(metadata.summary || content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) || "").trim();
  const keywords = parseKeywordValue(metadata.keywords);
  if (!title || !summary || keywords.length === 0) return null;

  const statusText = String(metadata.status || "active").trim();
  const status: RoleSkillStatus = statusText === "draft" || statusText === "archived" ? statusText : "active";
  const sourceSummary = String(metadata.source || "").trim();
  return {
    id: String(metadata.id || fallbackId).trim(),
    title,
    summary,
    source: sourceSummary ? { kind: "skill", summary: sourceSummary } : undefined,
    updatedAt: String(metadata.updatedAt || "").trim() || fs.statSync(filePath).mtime.toISOString(),
    status,
    keywords,
    path: filePath,
    content
  };
}

function plansDir(roleDir: string): string {
  return path.join(roleDir, "plans");
}

function memoryDir(roleDir: string): string {
  return path.join(roleDir, "memory");
}

function skillsDir(roleDir: string): string {
  return path.join(roleDir, "skills");
}

function planFile(roleDir: string, plan: PlanItem): string {
  const base = plan.status === "已归档" ? path.join(plansDir(roleDir), "archive") : path.join(plansDir(roleDir), "items", "active");
  return path.join(base, `${safeIdPart(plan.id) || "plan"}.json`);
}

function recentMemoryFile(roleDir: string, memory: RecentMemoryItem): string {
  return path.join(memoryDir(roleDir), "recent", `${safeIdPart(memory.id) || "memory"}.json`);
}

function consolidatedMemoryFile(roleDir: string, memory: ConsolidatedMemoryItem): string {
  return path.join(memoryDir(roleDir), "consolidated", `${safeIdPart(memory.id) || "consolidated-memory"}.json`);
}

function consolidationRunFile(roleDir: string, runId: string): string {
  return path.join(memoryDir(roleDir), "consolidation-runs", `${safeIdPart(runId) || "run"}.json`);
}

function allPlanFiles(roleDir: string): string[] {
  return [
    path.join(plansDir(roleDir), "items", "active"),
    path.join(plansDir(roleDir), "archive")
  ].flatMap((dir) => jsonFiles(dir));
}

export function listPlans(roleDir: string): PlanItem[] {
  const items = allPlanFiles(roleDir).flatMap((file) => {
    const raw = readJson<Record<string, unknown>>(file);
    const plan = raw ? normalizePlan(raw, path.basename(file, ".json")) : null;
    return plan ? [plan] : [];
  });
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function listRecentMemories(roleDir: string): RecentMemoryItem[] {
  return jsonFiles(path.join(memoryDir(roleDir), "recent")).flatMap((file) => {
    const raw = readJson<Record<string, unknown>>(file);
    const item = raw ? normalizeRecentMemory(raw, path.basename(file, ".json")) : null;
    return item ? [item] : [];
  });
}

export function getRecentMemory(roleDir: string, memoryId: string): RecentMemoryItem | undefined {
  const memory = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) return undefined;
  const viewed = { ...memory, viewedAt: nowIso() };
  writeJson(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

function touchRecentMemoryView(roleDir: string, memory: RecentMemoryItem, viewedAt = nowIso()): RecentMemoryItem {
  const viewed = { ...memory, viewedAt };
  writeJson(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidatedMemories(roleDir: string): ConsolidatedMemoryItem[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidated")).flatMap((file) => {
    const raw = readJson<Record<string, unknown>>(file);
    const item = raw ? normalizeConsolidatedMemory(raw, path.basename(file, ".json")) : null;
    return item ? [item] : [];
  });
}

export function listRoleSkillDetails(roleDir: string): RoleSkillDetail[] {
  return markdownFiles(skillsDir(roleDir)).flatMap((file) => {
    try {
      const item = parseSkillMarkdown(file);
      return item ? [item] : [];
    } catch {
      return [];
    }
  });
}

export function listRoleSkills(roleDir: string): RoleSkillItem[] {
  return listRoleSkillDetails(roleDir).map(({ content: _content, ...item }) => item);
}

export function getRoleSkill(roleDir: string, skillId: string): RoleSkillDetail | undefined {
  return listRoleSkillDetails(roleDir).find((item) => item.id === skillId);
}

export function getConsolidatedMemory(roleDir: string, memoryId: string): ConsolidatedMemoryItem | undefined {
  const memory = listConsolidatedMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) return undefined;
  const viewed = { ...memory, viewedAt: nowIso() };
  writeJson(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

function touchConsolidatedMemoryView(roleDir: string, memory: ConsolidatedMemoryItem, viewedAt = nowIso()): ConsolidatedMemoryItem {
  const viewed = { ...memory, viewedAt };
  writeJson(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidationRuns(roleDir: string): MemoryConsolidationRun[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).flatMap((file) => {
    const raw = readJson<MemoryConsolidationRun>(file);
    return raw ? [raw] : [];
  });
}

export function createPlan(roleDir: string, input: Record<string, unknown>): PlanItem {
  if (!String(input.focus || "").trim()) throw new Error("Plan focus is required and must describe one subject.");
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("plan", String(input.title || ""));
  const plan = normalizePlan({ ...input, id, createdAt: nowIso(), updatedAt: nowIso() });
  if (!plan) throw new Error("Plan title is required.");
  requireKeywords(plan.keywords, "Plan");
  validatePlanWrite(roleDir, plan, true);
  writeJson(planFile(roleDir, plan), plan);
  return plan;
}

export function updatePlan(roleDir: string, planId: string, patch: Record<string, unknown>): PlanItem {
  const existing = listPlans(roleDir).find((item) => item.id === planId);
  if (!existing) throw new Error(`Plan not found: ${planId}`);
  const next = normalizePlan({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() });
  if (!next) throw new Error("Plan title is required.");
  requireKeywords(next.keywords, "Plan");
  validatePlanWrite(roleDir, next);
  if (next.status === "已完成" && existing.status !== "已完成" && !next.completedAt) {
    next.completedAt = next.updatedAt;
  }
  for (const file of allPlanFiles(roleDir)) {
    const raw = readJson<Record<string, unknown>>(file);
    if (raw?.id === planId) {
      try { fs.unlinkSync(file); } catch { /* ignore stale file */ }
    }
  }
  writeJson(planFile(roleDir, next), next);
  return next;
}

export function createRecentMemory(roleDir: string, input: Record<string, unknown>): RecentMemoryItem {
  if (!String(input.focus || "").trim()) throw new Error("Memory focus is required and must describe one subject.");
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("memory", String(input.title || ""));
  const memory = normalizeRecentMemory({ ...input, id, createdAt: nowIso(), updatedAt: nowIso() });
  if (!memory) throw new Error("Memory title and content are required.");
  requireKeywords(memory.keywords, "Memory");
  validateMemoryWrite(roleDir, memory);
  writeJson(recentMemoryFile(roleDir, memory), memory);
  return memory;
}

export function updateRecentMemory(roleDir: string, memoryId: string, patch: Record<string, unknown>): RecentMemoryItem {
  const existing = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!existing) throw new Error(`Memory not found: ${memoryId}`);
  if (ageHours(memoryActivityAt(existing)) > DEFAULT_RECENT_EDITABLE_HOURS) {
    throw new Error(
      `Recent memory is outside the ${DEFAULT_RECENT_EDITABLE_HOURS}-hour editable window. Read it by ID before updating or record a new correction.`
    );
  }
  const touchedAt = nowIso();
  const next = normalizeRecentMemory({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: touchedAt, viewedAt: touchedAt });
  if (!next) throw new Error("Memory title and content are required.");
  requireKeywords(next.keywords, "Memory");
  validateMemoryWrite(roleDir, next);
  writeJson(recentMemoryFile(roleDir, next), next);
  return next;
}

export function archiveCompletedPlans(roleDir: string, archiveAfterHours = DEFAULT_PLAN_ARCHIVE_AFTER_HOURS): PlanItem[] {
  const archived: PlanItem[] = [];
  for (const plan of listPlans(roleDir)) {
    if (plan.status !== "已完成" || ageHours(plan.updatedAt) <= archiveAfterHours) continue;
    const next = { ...plan, status: "已归档" as const, archivedAt: nowIso(), updatedAt: nowIso() };
    updatePlan(roleDir, plan.id, next);
    archived.push(next);
  }
  return archived;
}

export function pendingMemoryConsolidation(
  roleDir: string,
  trigger: "auto" | "manual" | "api" = "auto",
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS,
  force = false
): MemoryConsolidationRequest | null {
  const memories = listRecentMemories(roleDir).filter((item) => !item.consolidatedAt);
  const shouldTrigger = force || memories.some((item) => ageHours(memoryActivityAt(item)) > recentConsolidationHours);
  if (!shouldTrigger) return null;

  const input = memories.filter((item) => ageHours(memoryActivityAt(item)) > recentEditableHours);
  if (input.length === 0) return null;

  const inputIds = input.map((item) => item.id).sort();
  const existingRun = listConsolidationRuns(roleDir)
    .filter((run) => run.status === "requested")
    .find((run) => {
      const runIds = [...run.inputMemoryIds].sort();
      return runIds.length === inputIds.length && runIds.every((id, index) => id === inputIds[index]);
    });
  if (existingRun) {
    return { run: existingRun, memories: input };
  }

  const run: MemoryConsolidationRun = {
    id: generatedId("memory-consolidation", "run"),
    roleDir,
    requestedAt: nowIso(),
    trigger,
    recentEditableHours,
    recentConsolidationHours,
    inputMemoryIds: inputIds,
    status: "requested",
    instruction: "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。"
  };
  writeJson(consolidationRunFile(roleDir, run.id), run);
  return { run, memories: input };
}

export function createMemoryConsolidationRequest(
  roleDir: string,
  options: CreateMemoryConsolidationRequestOptions = {}
): MemoryConsolidationRequest {
  const request = pendingMemoryConsolidation(
    roleDir,
    options.triggerSource ?? "api",
    options.includeOlderThanHours ?? DEFAULT_RECENT_EDITABLE_HOURS,
    options.triggerOlderThanHours ?? DEFAULT_RECENT_CONSOLIDATION_HOURS,
    options.force === true
  );
  if (!request) {
    throw new Error("No recent memories are eligible for consolidation.");
  }
  return request;
}

export function completeMemoryConsolidation(roleDir: string, runId: string, rawItems: unknown): {
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
} {
  const run = readJson<MemoryConsolidationRun>(consolidationRunFile(roleDir, runId));
  if (!run) throw new Error(`Memory consolidation run not found: ${runId}`);
  if (run.status === "completed") {
    const memories = listConsolidatedMemories(roleDir)
      .filter((item) => item.consolidationRunId === run.id || run.outputMemoryIds?.includes(item.id));
    return { run, memories };
  }

  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const output = items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    if (!String(source.focus || "").trim()) {
      throw new Error("Consolidated memory focus is required and must describe one subject.");
    }
    const memory = normalizeConsolidatedMemory({
      ...source,
      id: typeof source.id === "string" && source.id ? source.id : generatedId("consolidated-memory", String(source.title || `memory-${index + 1}`)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      inputMemoryIds: Array.isArray(source.inputMemoryIds) ? source.inputMemoryIds : run.inputMemoryIds,
      consolidationRunId: run.id
    });
    if (!memory) return [];
    return [memory];
  });

  if (output.length === 0) {
    throw new Error("At least one consolidated memory is required.");
  }

  for (const memory of output) {
    requireKeywords(memory.keywords, "Consolidated memory");
    validateMemoryWrite(roleDir, memory, "Consolidated memory");
  }

  for (const memory of output) {
    writeJson(consolidatedMemoryFile(roleDir, memory), memory);
  }

  const completedAt = nowIso();
  for (const memory of listRecentMemories(roleDir).filter((item) => run.inputMemoryIds.includes(item.id))) {
    writeJson(recentMemoryFile(roleDir, memory), {
      ...memory,
      consolidatedAt: completedAt,
      consolidationRunId: run.id
    });
  }

  const completedRun: MemoryConsolidationRun = {
    ...run,
    completedAt,
    outputMemoryIds: output.map((item) => item.id),
    status: "completed"
  };
  writeJson(consolidationRunFile(roleDir, run.id), completedRun);

  return { run: completedRun, memories: output };
}

export function validateRoleKnowledge(roleDir: string): RoleKnowledgeValidationResult {
  const issues: RoleKnowledgeValidationIssue[] = [];
  for (const plan of listPlans(roleDir)) {
    try {
      requireKeywords(plan.keywords, "Plan");
      validatePlanWrite(roleDir, plan);
    } catch (error) {
      issues.push({ type: "plan", id: plan.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const memory of listRecentMemories(roleDir)) {
    try {
      requireKeywords(memory.keywords, "Memory");
      validateMemoryWrite(roleDir, memory);
    } catch (error) {
      issues.push({ type: "recent_memory", id: memory.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const memory of listConsolidatedMemories(roleDir)) {
    try {
      requireKeywords(memory.keywords, "Consolidated memory");
      validateMemoryWrite(roleDir, memory, "Consolidated memory");
    } catch (error) {
      issues.push({ type: "consolidated_memory", id: memory.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: issues.length === 0, limits: roleKnowledgeWriteLimits(roleDir), issues };
}

export function applyMemoryConsolidationResult(roleDir: string, runId: string, body: Record<string, unknown>): {
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
} {
  const items = Array.isArray(body.memories)
    ? body.memories
    : Array.isArray(body.consolidatedMemories)
      ? body.consolidatedMemories
      : Array.isArray(body.items)
        ? body.items
        : body;
  return completeMemoryConsolidation(roleDir, runId, items);
}

type ScoredKnowledgeCandidate = RoleKnowledgeIndexItem & {
  endpoint: string;
  score: number;
  activityAt: string;
  memory?: RecentMemoryItem | ConsolidatedMemoryItem;
  skill?: RoleSkillItem;
};

const DEFAULT_REQUIRED_READ_LIMIT = 5;
const MATCHED_ITEM_LIMIT = 12;

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function usefulKeyword(keyword: string): string {
  const normalized = normalizedText(keyword);
  if (normalized.length < 2) return "";
  if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) return "";
  return normalized;
}

function scoreKnowledgeMatch(
  messageText: string,
  item: { id: string; title: string; keywords?: string[] },
  activeBoost = 0
): number {
  const normalized = normalizedText(messageText);
  if (!normalized) return 0;

  let baseScore = 0;
  const id = normalizedText(item.id);
  const title = normalizedText(item.title);
  if (id && normalized.includes(id)) baseScore += 100;
  if (title.length >= 2 && normalized.includes(title)) baseScore += 80;

  let keywordScore = 0;
  for (const keyword of item.keywords ?? []) {
    const normalizedKeyword = usefulKeyword(keyword);
    if (normalizedKeyword && normalized.includes(normalizedKeyword)) {
      keywordScore += 20;
    }
  }
  baseScore += Math.min(keywordScore, 60);

  return baseScore > 0 ? baseScore + activeBoost : 0;
}

export function scoreSkillMatch(messageText: string, skill: RoleSkillItem): number {
  return scoreKnowledgeMatch(messageText, {
    id: skill.id,
    title: skill.title,
    keywords: [skill.summary, ...skill.keywords]
  }, skill.status === "active" ? 5 : 0);
}

function roleApiBase(roleId: string): string {
  return `/api/roles/${encodeURIComponent(roleId)}`;
}

function requiredReadEndpoint(roleId: string, type: RoleKnowledgeItemType, id: string): string {
  const base = roleApiBase(roleId);
  const encodedId = encodeURIComponent(id);
  if (type === "plan") return `${base}/plans/${encodedId}`;
  if (type === "recent_memory") return `${base}/memory/recent/${encodedId}`;
  if (type === "role_skill") return `${base}/skills/${encodedId}`;
  return `${base}/memory/consolidated/${encodedId}`;
}

function sortScoredCandidates(left: ScoredKnowledgeCandidate, right: ScoredKnowledgeCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = Date.parse(right.activityAt);
  const leftTime = Date.parse(left.activityAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
}

export function roleKnowledgeSnapshot(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions = {}
): RoleKnowledgeSnapshot {
  archiveCompletedPlans(roleDir);
  const plans = listPlans(roleDir);
  const memories = listRecentMemories(roleDir);
  const consolidatedMemories = listConsolidatedMemories(roleDir);
  const skills = listRoleSkills(roleDir);
  const activePlans = plans.filter((item) => item.status === "进行中");
  const activeSkills = skills.filter((item) => item.status === "active");
  const recentMemories = memories.filter((item) => !item.consolidatedAt && ageHours(memoryActivityAt(item)) <= DEFAULT_RECENT_EDITABLE_HOURS);
  const roleId = options.roleId || path.basename(roleDir);
  const recentMemoryIds = new Set(recentMemories.map((item) => item.id));
  const scoredCandidates: ScoredKnowledgeCandidate[] = [
    ...plans
      .filter((item) => item.status !== "已归档")
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: "plan" as const,
        endpoint: requiredReadEndpoint(roleId, "plan", item.id),
        score: scoreKnowledgeMatch(messageText, item, item.status === "进行中" ? 5 : 0),
        activityAt: item.updatedAt
      })),
    ...memories
      .filter((item) => !item.consolidatedAt)
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: "recent_memory" as const,
        endpoint: requiredReadEndpoint(roleId, "recent_memory", item.id),
        score: scoreKnowledgeMatch(messageText, item, recentMemoryIds.has(item.id) ? 5 : 0),
        activityAt: memoryActivityAt(item),
        memory: item
      })),
    ...consolidatedMemories.map((item) => ({
      id: item.id,
      title: item.title,
      type: "consolidated_memory" as const,
      endpoint: requiredReadEndpoint(roleId, "consolidated_memory", item.id),
      score: scoreKnowledgeMatch(messageText, item),
      activityAt: memoryActivityAt(item),
      memory: item
    })),
    ...skills
      .filter((item) => item.status !== "archived")
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: "role_skill" as const,
        endpoint: requiredReadEndpoint(roleId, "role_skill", item.id),
        score: scoreSkillMatch(messageText, item),
        activityAt: item.updatedAt,
        skill: item
      }))
  ].filter((item) => item.score > 0).sort(sortScoredCandidates);

  const requiredReadItems = scoredCandidates
    .slice(0, options.requiredReadLimit ?? DEFAULT_REQUIRED_READ_LIMIT)
    .map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      endpoint: item.endpoint,
      score: item.score
    }));

  const touchedAt = nowIso();
  for (const item of requiredReadItems) {
    const candidate = scoredCandidates.find((candidateItem) => candidateItem.type === item.type && candidateItem.id === item.id);
    if (candidate?.type === "recent_memory" && candidate.memory) {
      touchRecentMemoryView(roleDir, candidate.memory as RecentMemoryItem, touchedAt);
    }
    if (candidate?.type === "consolidated_memory" && candidate.memory) {
      touchConsolidatedMemoryView(roleDir, candidate.memory as ConsolidatedMemoryItem, touchedAt);
    }
  }

  return {
    roleDir,
    plansDir: plansDir(roleDir),
    memoryDir: memoryDir(roleDir),
    agentInterfaceDocPath: path.join(rootDir, "docs", "rabi-agent-interfaces.md"),
    activePlans,
    activeSkills,
    recentMemories,
    matchedItems: scoredCandidates.slice(0, MATCHED_ITEM_LIMIT).map((item) => ({ id: item.id, title: item.title, type: item.type })),
    matchedSkills: scoredCandidates.filter((item) => item.type === "role_skill" && item.skill).slice(0, MATCHED_ITEM_LIMIT).map((item) => item.skill as RoleSkillItem),
    requiredReadItems,
    pendingConsolidation: options.includePendingConsolidation
      ? pendingMemoryConsolidation(
          roleDir,
          options.consolidationTrigger ?? "auto",
          DEFAULT_RECENT_EDITABLE_HOURS,
          DEFAULT_RECENT_CONSOLIDATION_HOURS,
          options.forceConsolidation === true
        ) ?? undefined
      : undefined
  };
}

function indexTypeLabel(type: RoleKnowledgeItemType): string {
  if (type === "plan") return "计划";
  if (type === "recent_memory") return "近期记忆";
  if (type === "role_skill") return "角色技能";
  return "沉淀记忆";
}

export function indexLines<T extends { id: string; title: string }>(items: T[], empty = "- 暂无"): string {
  if (items.length === 0) return empty;
  return items.map((item) => {
    const type = "type" in item ? (item as T & { type?: RoleKnowledgeItemType }).type : undefined;
    const prefix = type ? `[${indexTypeLabel(type)}] ` : "";
    return `- ${prefix}${item.id}：${item.title}`;
  }).join("\n");
}
