import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type PlanStatus = "未开始" | "进行中" | "已完成" | "已归档";

export type KnowledgeSource = {
  kind?: string;
  summary?: string;
};

export type PlanItem = {
  id: string;
  title: string;
  status: PlanStatus;
  priority?: string;
  kind?: string;
  currentStep?: string;
  nextAction?: string;
  waitingFor?: string;
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
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  consolidatedAt?: string;
  consolidationRunId?: string;
  keywords: string[];
};

export type ConsolidatedMemoryItem = {
  id: string;
  title: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  inputMemoryIds?: string[];
  consolidationRunId?: string;
  keywords: string[];
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
  recentMemories: RecentMemoryItem[];
  matchedItems: Array<{ id: string; title: string; type: "plan" | "memory" }>;
  pendingConsolidation?: MemoryConsolidationRequest;
};

export type RoleKnowledgeSnapshotOptions = {
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
  forceConsolidation?: boolean;
};

export const DEFAULT_PLAN_ARCHIVE_AFTER_HOURS = 72;
export const DEFAULT_RECENT_EDITABLE_HOURS = 24;
export const DEFAULT_RECENT_CONSOLIDATION_HOURS = 72;

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

function ageHours(updatedAt: string, now = Date.now()): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now - parsed) / 3_600_000);
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24);
}

function requireKeywords(keywords: string[], label: string): void {
  if (keywords.length === 0) {
    throw new Error(`${label} keywords are required.`);
  }
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
    status,
    priority: typeof raw.priority === "string" ? raw.priority : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    currentStep: typeof raw.currentStep === "string" ? raw.currentStep : undefined,
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction : undefined,
    waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
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
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
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
    content,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    inputMemoryIds: Array.isArray(raw.inputMemoryIds) ? raw.inputMemoryIds.map(String) : undefined,
    consolidationRunId: typeof raw.consolidationRunId === "string" ? raw.consolidationRunId : undefined,
    keywords: normalizeKeywords(raw.keywords)
  };
}

function plansDir(roleDir: string): string {
  return path.join(roleDir, "plans");
}

function memoryDir(roleDir: string): string {
  return path.join(roleDir, "memory");
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

export function listConsolidatedMemories(roleDir: string): ConsolidatedMemoryItem[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidated")).flatMap((file) => {
    const raw = readJson<Record<string, unknown>>(file);
    const item = raw ? normalizeConsolidatedMemory(raw, path.basename(file, ".json")) : null;
    return item ? [item] : [];
  });
}

export function listConsolidationRuns(roleDir: string): MemoryConsolidationRun[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).flatMap((file) => {
    const raw = readJson<MemoryConsolidationRun>(file);
    return raw ? [raw] : [];
  });
}

export function createPlan(roleDir: string, input: Record<string, unknown>): PlanItem {
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("plan", String(input.title || ""));
  const plan = normalizePlan({ ...input, id, createdAt: nowIso(), updatedAt: nowIso() });
  if (!plan) throw new Error("Plan title is required.");
  requireKeywords(plan.keywords, "Plan");
  writeJson(planFile(roleDir, plan), plan);
  return plan;
}

export function updatePlan(roleDir: string, planId: string, patch: Record<string, unknown>): PlanItem {
  const existing = listPlans(roleDir).find((item) => item.id === planId);
  if (!existing) throw new Error(`Plan not found: ${planId}`);
  const next = normalizePlan({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() });
  if (!next) throw new Error("Plan title is required.");
  requireKeywords(next.keywords, "Plan");
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
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("memory", String(input.title || ""));
  const memory = normalizeRecentMemory({ ...input, id, createdAt: nowIso(), updatedAt: nowIso() });
  if (!memory) throw new Error("Memory title and content are required.");
  requireKeywords(memory.keywords, "Memory");
  writeJson(recentMemoryFile(roleDir, memory), memory);
  return memory;
}

export function updateRecentMemory(roleDir: string, memoryId: string, patch: Record<string, unknown>): RecentMemoryItem {
  const existing = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!existing) throw new Error(`Memory not found: ${memoryId}`);
  const next = normalizeRecentMemory({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() });
  if (!next) throw new Error("Memory title and content are required.");
  requireKeywords(next.keywords, "Memory");
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
  const shouldTrigger = force || memories.some((item) => ageHours(item.updatedAt) > recentConsolidationHours);
  if (!shouldTrigger) return null;

  const input = memories.filter((item) => ageHours(item.updatedAt) > recentEditableHours);
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

function matchesText(text: string, item: { title: string; keywords?: string[] }): boolean {
  const normalized = text.toLowerCase();
  if (item.title && normalized.includes(item.title.toLowerCase())) return true;
  return (item.keywords ?? []).some((keyword) => keyword && normalized.includes(keyword.toLowerCase()));
}

export function roleKnowledgeSnapshot(
  roleDir: string,
  messageText: string,
  options: RoleKnowledgeSnapshotOptions = {}
): RoleKnowledgeSnapshot {
  archiveCompletedPlans(roleDir);
  const plans = listPlans(roleDir);
  const memories = listRecentMemories(roleDir);
  const activePlans = plans.filter((item) => item.status === "进行中");
  const recentMemories = memories.filter((item) => !item.consolidatedAt && ageHours(item.updatedAt) <= DEFAULT_RECENT_EDITABLE_HOURS);
  const matchedPlans = plans
    .filter((item) => item.status !== "已归档" && !activePlans.some((active) => active.id === item.id) && matchesText(messageText, item))
    .map((item) => ({ id: item.id, title: item.title, type: "plan" as const }));
  const matchedMemories = memories
    .filter((item) => !item.consolidatedAt && !recentMemories.some((memory) => memory.id === item.id) && matchesText(messageText, item))
    .map((item) => ({ id: item.id, title: item.title, type: "memory" as const }));
  return {
    roleDir,
    plansDir: plansDir(roleDir),
    memoryDir: memoryDir(roleDir),
    agentInterfaceDocPath: path.join(rootDir, "docs", "rabi-agent-interfaces.md"),
    activePlans,
    recentMemories,
    matchedItems: [...matchedPlans, ...matchedMemories].slice(0, 12),
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

export function indexLines<T extends { id: string; title: string }>(items: T[], empty = "- 暂无"): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item.id}：${item.title}`).join("\n");
}
