import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  normalizeStoredPlanAttachments,
  storePlanAttachments
} from "./planAttachments.js";
import type { PlanAttachment } from "./shared/planAttachmentContract.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type PlanStatus = "未开始" | "进行中" | "暂停" | "已完成" | "已归档";
export type PlanStepStatus = "未开始" | "进行中" | "已完成";

export type PlanApprovalFileAction = "create" | "modify" | "delete" | "move";

export type PlanApprovalFileChange = {
  path: string;
  action: PlanApprovalFileAction;
  change: string;
  destination?: string;
};

export type PlanApprovalCommand = {
  command: string;
  purpose: string;
  expectedEffect?: string;
};

export type PlanApprovalExternalChange = {
  target: string;
  change: string;
  impact?: string;
};

export type PlanApprovalRequest = {
  approver?: string;
  request: string;
  recommendation?: string;
  alternatives?: string[];
  reason: string;
  files: PlanApprovalFileChange[];
  commands: PlanApprovalCommand[];
  changes: PlanApprovalExternalChange[];
  validation: string[];
  rollback: string[];
  outOfScope: string[];
  requestedAt?: string;
  sourceMessageId?: string;
  feedbackId?: string;
  responseStatus?: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled";
};

export type PlanApprovalGateState = "none" | "preparing" | "pending";

export type PlanApprovalGate = {
  state: PlanApprovalGateState;
  stepId?: string;
  missing: string[];
  contract?: PlanApprovalRequest;
};

export type PlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  detail?: string;
  waitingFor?: string;
  /** Compatibility projection. Manager derives this from a complete pending approvalRequest. */
  isBlocked?: boolean;
  /** Human-readable explanation only; it does not decide blocked state. */
  blockedBy?: string;
  startedAt?: string;
  completedAt?: string;
  approvalRequest?: PlanApprovalRequest;
};

export type KnowledgeSource = {
  kind?: string;
  summary?: string;
};

export type PlanTaskCompletionHook = {
  enabled: boolean;
  gatewayId?: string;
};

export type PlanTaskBinding = {
  agentType: "codex";
  sessionId: string;
  sessionTitle?: string;
  workspace?: string;
  completionHook?: PlanTaskCompletionHook;
};

export type PlanSecretaryBinding = {
  agentType: "codex";
  sessionId: string;
  sessionTitle?: string;
  workspace: string;
  assignedAt?: string;
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
  /** Compatibility projection. Manager derives this from the current approval gate. */
  isBlocked?: boolean;
  /** Human-readable explanation only; it does not decide blocked state. */
  blockedBy?: string;
  attachments: PlanAttachment[];
  steps: PlanStep[];
  project?: {
    name?: string;
    path?: string;
  };
  source?: KnowledgeSource;
  /** Control-plane owner. This is separate from the business taskBinding. */
  secretaryBinding?: PlanSecretaryBinding;
  taskBinding?: PlanTaskBinding;
  dueAt?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
};

export type PlanUpdatedEvent = {
  roleDir: string;
  before: PlanItem;
  after: PlanItem;
};

const planUpdatedListeners = new Set<(event: PlanUpdatedEvent) => void>();

export function subscribePlanUpdates(listener: (event: PlanUpdatedEvent) => void): () => void {
  planUpdatedListeners.add(listener);
  return () => planUpdatedListeners.delete(listener);
}

function notifyPlanUpdated(event: PlanUpdatedEvent): void {
  for (const listener of planUpdatedListeners) {
    try {
      listener(event);
    } catch {
      // Plan persistence already succeeded. Observers report their own delivery failures.
    }
  }
}

export type RecentMemoryItem = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  recalledAt?: string;
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
  recalledAt?: string;
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
  deliveredAt?: string;
  completedAt?: string;
  trigger: "auto" | "manual" | "api";
  recentEditableHours: number;
  recentConsolidationHours: number;
  triggerMemoryId?: string;
  triggerAt?: string;
  candidateCutoffAt?: string;
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
  summary?: string;
};

export type RequiredReadItem = RoleKnowledgeIndexItem & {
  endpoint: string;
  score: number;
  revisionAt: string;
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
  contextInjection: RoleContextInjectionPolicy;
  pendingConsolidation?: MemoryConsolidationRequest;
};

export type RoleContextInjectionMode = "focused" | "legacy";

export type RoleContextInjectionPolicy = {
  mode: RoleContextInjectionMode;
  requiredReadLimit: number;
  matchedItemLimit: number;
  personaMaxChars: number;
};

export const DEFAULT_FOCUSED_CONTEXT_INJECTION: RoleContextInjectionPolicy = {
  mode: "focused",
  requiredReadLimit: 3,
  matchedItemLimit: 3,
  personaMaxChars: 1600
};

export const DEFAULT_LEGACY_CONTEXT_INJECTION: RoleContextInjectionPolicy = {
  mode: "legacy",
  requiredReadLimit: 5,
  matchedItemLimit: 12,
  personaMaxChars: 3200
};

export type RoleKnowledgeSnapshotOptions = {
  roleId?: string;
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
  forceConsolidation?: boolean;
  requiredReadLimit?: number;
  archiveCompletedPlans?: boolean;
  touchViewedAt?: boolean;
  touchRequiredRead?: (item: RequiredReadItem) => boolean;
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
  approvalRequestChars: number;
  approvalReasonChars: number;
  approvalPathChars: number;
  approvalDetailChars: number;
  approvalCommandChars: number;
  approvalListItemChars: number;
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
    approvalRequestChars: 600,
    approvalReasonChars: 600,
    approvalPathChars: 1000,
    approvalDetailChars: 800,
    approvalCommandChars: 2000,
    approvalListItemChars: 800,
    maxSteps: 100,
    nextActionChars: 600,
    waitingForChars: 300,
    blockedByChars: 600,
    sourceSummaryChars: 240,
    keywordChars: 32,
    maxKeywords: 24,
    totalChars: 12000
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

function parseMemoryMarkdown(filePath: string): Record<string, unknown> | null {
  try {
    const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const metadata: Record<string, unknown> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!pair) continue;
      const rawValue = pair[2].trim();
      try {
        metadata[pair[1]] = JSON.parse(rawValue);
      } catch {
        metadata[pair[1]] = rawValue.replace(/^["']|["']$/g, "");
      }
    }
    metadata.content = source.slice(match[0].length).trim();
    return metadata;
  } catch {
    return null;
  }
}

function memoryMarkdown(value: RecentMemoryItem | ConsolidatedMemoryItem): string {
  const { content, ...metadata } = value;
  const frontmatter = Object.entries(metadata)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${key}: ${JSON.stringify(field)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${content.trim()}\n`;
}

function writeMemoryMarkdown(filePath: string, value: RecentMemoryItem | ConsolidatedMemoryItem): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, memoryMarkdown(value), "utf8");
}

function memoryConsolidationActivityAt(memory: { updatedAt: string; recalledAt?: string }): string {
  return laterIso(memory.updatedAt, memory.recalledAt);
}

export type MemoryLifecyclePresentation = {
  kind: "recent" | "consolidated";
  state: "active" | "eligible" | "trigger_due" | "consolidated_source" | "consolidated";
  activityAt: string;
  consolidationEligibleAt?: string;
  consolidationTriggerAt?: string;
  triggersNextConsolidation?: boolean;
  willEnterNextConsolidation?: boolean;
};

type RecentMemoryConsolidationProjectionItem = {
  activityAt: string;
  consolidationEligibleAt: string;
  consolidationTriggerAt: string;
  triggersNextConsolidation: boolean;
  willEnterNextConsolidation: boolean;
};

type RecentMemoryConsolidationProjection = Map<string, RecentMemoryConsolidationProjectionItem>;

type RecentMemoryConsolidationScheduleItem = {
  memory: RecentMemoryItem;
  activityAt: string;
  consolidationEligibleAt: string;
  consolidationTriggerAt: string;
};

type RecentMemoryConsolidationCohort = {
  schedule: RecentMemoryConsolidationScheduleItem[];
  trigger?: RecentMemoryConsolidationScheduleItem;
  candidateCutoffAt?: string;
  candidates: RecentMemoryItem[];
};

type RecentMemoryConsolidationProjectionCacheEntry = {
  validUntil: number;
  projection: RecentMemoryConsolidationProjection;
};

const recentMemoryConsolidationProjectionCache = new Map<string, RecentMemoryConsolidationProjectionCacheEntry>();

function isoAfterHours(value: string, hours: number): string {
  const parsed = Date.parse(value);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + hours * 3_600_000).toISOString();
}

function recentMemoryConsolidationCohort(
  memories: RecentMemoryItem[],
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS
): RecentMemoryConsolidationCohort {
  const schedule = memories
    .filter((memory) => !memory.consolidatedAt)
    .map((memory) => {
      const activityAt = memoryConsolidationActivityAt(memory);
      return {
        memory,
        activityAt,
        consolidationEligibleAt: isoAfterHours(activityAt, recentEditableHours),
        consolidationTriggerAt: isoAfterHours(activityAt, recentConsolidationHours)
      };
    })
    .sort((left, right) => {
      const timeDifference = Date.parse(left.consolidationTriggerAt) - Date.parse(right.consolidationTriggerAt);
      return timeDifference || left.memory.id.localeCompare(right.memory.id);
    });
  const trigger = schedule[0];
  const triggerAt = Date.parse(trigger?.consolidationTriggerAt || "");
  if (!Number.isFinite(triggerAt)) return { schedule, trigger, candidates: [] };
  const candidateCutoffAt = new Date(triggerAt - recentEditableHours * 3_600_000).toISOString();
  return {
    schedule,
    trigger,
    candidateCutoffAt,
    candidates: schedule
      .filter((item) => Date.parse(item.activityAt) < Date.parse(candidateCutoffAt))
      .map((item) => item.memory)
  };
}

export function presentRoleMemory<T extends RecentMemoryItem | ConsolidatedMemoryItem>(
  memory: T,
  kind: "recent" | "consolidated",
  now = Date.now(),
  consolidationProjection?: RecentMemoryConsolidationProjection
): T & { lifecycle: MemoryLifecyclePresentation } {
  const activityAt = kind === "recent"
    ? memoryConsolidationActivityAt(memory)
    : memoryActivityAt(memory);
  if (kind === "consolidated") {
    return {
      ...memory,
      lifecycle: { kind, state: "consolidated", activityAt }
    };
  }
  if ("consolidatedAt" in memory && memory.consolidatedAt) {
    return {
      ...memory,
      lifecycle: { kind, state: "consolidated_source", activityAt }
    };
  }
  const projection = consolidationProjection?.get(memory.id);
  const consolidationEligibleAt = projection?.consolidationEligibleAt
    ?? isoAfterHours(activityAt, DEFAULT_RECENT_EDITABLE_HOURS);
  const consolidationTriggerAt = projection?.consolidationTriggerAt
    ?? isoAfterHours(activityAt, DEFAULT_RECENT_CONSOLIDATION_HOURS);
  const state = now >= Date.parse(consolidationTriggerAt)
    ? "trigger_due"
    : now >= Date.parse(consolidationEligibleAt)
      ? "eligible"
      : "active";
  return {
    ...memory,
    lifecycle: {
      kind,
      state,
      activityAt,
      consolidationEligibleAt,
      consolidationTriggerAt,
      triggersNextConsolidation: projection?.triggersNextConsolidation,
      willEnterNextConsolidation: projection?.willEnterNextConsolidation
    }
  };
}

function recentMemoryConsolidationProjection(
  roleDir: string,
  memories: RecentMemoryItem[]
): RecentMemoryConsolidationProjection {
  const cacheKey = memoryCatalogDirectory(roleDir, "recent");
  const cached = recentMemoryConsolidationProjectionCache.get(cacheKey);
  if (cached && cached.validUntil > Date.now()) return cached.projection;

  const cohort = recentMemoryConsolidationCohort(memories);
  const nextTrigger = cohort.trigger;
  const candidateIds = new Set(cohort.candidates.map((memory) => memory.id));
  const projection = new Map<string, RecentMemoryConsolidationProjectionItem>();
  for (const item of cohort.schedule) {
    projection.set(item.memory.id, {
      activityAt: item.activityAt,
      consolidationEligibleAt: item.consolidationEligibleAt,
      consolidationTriggerAt: item.consolidationTriggerAt,
      triggersNextConsolidation: item.memory.id === nextTrigger?.memory.id,
      willEnterNextConsolidation: candidateIds.has(item.memory.id)
    });
  }
  recentMemoryConsolidationProjectionCache.set(cacheKey, {
    validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS,
    projection
  });
  return projection;
}

export function presentRoleMemories<T extends RecentMemoryItem | ConsolidatedMemoryItem>(
  roleDir: string,
  memories: T[],
  kind: "recent" | "consolidated",
  now = Date.now()
): Array<T & { lifecycle: MemoryLifecyclePresentation }> {
  const projection = kind === "recent"
    ? recentMemoryConsolidationProjection(roleDir, memories as RecentMemoryItem[])
    : undefined;
  return memories.map((memory) => presentRoleMemory(memory, kind, now, projection));
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

function boundedContextLimit(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function normalizeRoleContextInjection(value: unknown): RoleContextInjectionPolicy {
  const raw = recordValue(value);
  const defaults = raw.mode === "legacy"
    ? DEFAULT_LEGACY_CONTEXT_INJECTION
    : DEFAULT_FOCUSED_CONTEXT_INJECTION;
  const relevantKnowledgeLimit = raw.relevantKnowledgeLimit == null
    ? undefined
    : boundedContextLimit(raw.relevantKnowledgeLimit, defaults.requiredReadLimit, 1, 12);
  return {
    mode: defaults.mode,
    requiredReadLimit: relevantKnowledgeLimit ?? defaults.requiredReadLimit,
    matchedItemLimit: relevantKnowledgeLimit ?? defaults.matchedItemLimit,
    personaMaxChars: boundedContextLimit(raw.personaMaxChars, defaults.personaMaxChars, 800, 6000)
  };
}

export function roleContextInjectionPolicy(roleDir: string): RoleContextInjectionPolicy {
  const config = readJson<Record<string, unknown>>(path.join(roleDir, "personaConfig.json")) ?? {};
  return normalizeRoleContextInjection(config.contextInjection);
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

function approvalRequestText(contract: PlanApprovalRequest | undefined): unknown[] {
  if (!contract) return [];
  return [
    contract.approver,
    contract.request,
    contract.recommendation,
    ...(contract.alternatives || []),
    contract.reason,
    ...contract.files.flatMap((item) => [item.path, item.action, item.change, item.destination]),
    ...contract.commands.flatMap((item) => [item.command, item.purpose, item.expectedEffect]),
    ...contract.changes.flatMap((item) => [item.target, item.change, item.impact]),
    ...contract.validation,
    ...contract.rollback,
    ...contract.outOfScope,
    contract.requestedAt,
    contract.sourceMessageId,
    contract.feedbackId,
    contract.responseStatus
  ];
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
    plan.secretaryBinding?.agentType,
    plan.secretaryBinding?.sessionId,
    plan.secretaryBinding?.sessionTitle,
    plan.secretaryBinding?.workspace,
    plan.secretaryBinding?.assignedAt,
    plan.taskBinding?.agentType,
    plan.taskBinding?.sessionId,
    plan.taskBinding?.sessionTitle,
    plan.taskBinding?.workspace,
    plan.taskBinding?.completionHook?.gatewayId,
    ...plan.steps.flatMap((step) => [
      step.id,
      step.title,
      step.detail,
      step.waitingFor,
      step.blockedBy,
      step.startedAt,
      step.completedAt,
      ...approvalRequestText(step.approvalRequest)
    ]),
    ...plan.keywords
  ].reduce<number>((total, value) => total + textChars(value), 0);
}

export function currentPlanStep(plan: PlanItem): PlanStep | undefined {
  if (plan.currentStepId) {
    const explicit = plan.steps.find((step) => step.id === plan.currentStepId);
    if (explicit) return explicit;
  }
  return plan.steps.find((step) => step.status === "进行中");
}

function planHasApprovalIntent(plan: PlanItem): boolean {
  if (plan.status === "暂停" || plan.status === "已完成" || plan.status === "已归档") return false;
  const step = currentPlanStep(plan);
  if (step?.approvalRequest) {
    const responseStatus = step.approvalRequest.responseStatus;
    if (responseStatus === "approved" || responseStatus === "rejected" || responseStatus === "changes_requested" || responseStatus === "cancelled") return false;
    return true;
  }
  if (/human-gate/i.test(String(plan.kind || ""))) return true;
  const explicitGate = [
    step?.id,
    step?.title,
    step?.waitingFor,
    step?.blockedBy,
    plan.waitingFor,
    plan.blockedBy
  ];
  return explicitGate.some((signal) => {
    const normalized = String(signal || "").replace(/\s+/g, "");
    return /(等待|待|需要|未经).*(审批|批准|授权|审核|人工决策)|^(审批|批准|授权|审核|人工决策)/i.test(normalized);
  });
}

export function approvalRequestMissingFields(contract: PlanApprovalRequest | undefined): string[] {
  if (!contract) return [
    "approver",
    "request",
    "recommendation",
    "alternatives",
    "reason",
    "affectedActions",
    "validation",
    "rollback",
    "outOfScope",
    "requestedAt",
    "source",
    "responseStatus"
  ];
  const missing: string[] = [];
  if (!contract.approver?.trim()) missing.push("approver");
  if (!contract.request.trim()) missing.push("request");
  if (!contract.recommendation?.trim()) missing.push("recommendation");
  if (!contract.alternatives?.some((item) => item.trim())) missing.push("alternatives");
  if (!contract.reason.trim()) missing.push("reason");
  const hasFile = contract.files.some((item) => item.path.trim() && item.change.trim() && (item.action !== "move" || item.destination?.trim()));
  const hasCommand = contract.commands.some((item) => item.command.trim() && item.purpose.trim());
  const hasChange = contract.changes.some((item) => item.target.trim() && item.change.trim());
  if (!hasFile && !hasCommand && !hasChange) missing.push("affectedActions");
  if (contract.validation.length === 0) missing.push("validation");
  if (contract.rollback.length === 0) missing.push("rollback");
  if (contract.outOfScope.length === 0) missing.push("outOfScope");
  if (!contract.requestedAt?.trim()) missing.push("requestedAt");
  if (!contract.sourceMessageId?.trim() && !contract.feedbackId?.trim()) missing.push("source");
  if (!contract.responseStatus) missing.push("responseStatus");
  return missing;
}

export function planApprovalGate(plan: PlanItem): PlanApprovalGate {
  if (!planHasApprovalIntent(plan)) return { state: "none", missing: [] };
  const step = currentPlanStep(plan);
  const contract = step?.approvalRequest;
  const missing = approvalRequestMissingFields(contract);
  return {
    state: missing.length === 0 ? "pending" : "preparing",
    stepId: step?.id,
    missing,
    contract
  };
}

export function planRequiresApproval(plan: PlanItem): boolean {
  return planApprovalGate(plan).state !== "none";
}

export function planAcceptsGuidance(plan: PlanItem): boolean {
  return plan.status === "进行中" && planApprovalGate(plan).state === "none";
}

function validateApprovalRequest(contract: PlanApprovalRequest, limits: PlanWriteLimits): void {
  assertTextLimit("Plan approvalRequest.approver", contract.approver, limits.approvalDetailChars);
  assertTextLimit("Plan approvalRequest.request", contract.request, limits.approvalRequestChars);
  assertTextLimit("Plan approvalRequest.recommendation", contract.recommendation, limits.approvalRequestChars);
  assertTextLimit("Plan approvalRequest.reason", contract.reason, limits.approvalReasonChars);
  if (contract.files.length > 50) throw new Error("Plan approvalRequest.files cannot contain more than 50 items.");
  if (contract.commands.length > 50) throw new Error("Plan approvalRequest.commands cannot contain more than 50 items.");
  if (contract.changes.length > 50) throw new Error("Plan approvalRequest.changes cannot contain more than 50 items.");
  for (const item of contract.files) {
    assertTextLimit("Plan approvalRequest file path", item.path, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest file destination", item.destination, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest file change", item.change, limits.approvalDetailChars);
  }
  for (const item of contract.commands) {
    assertTextLimit("Plan approvalRequest command", item.command, limits.approvalCommandChars);
    assertTextLimit("Plan approvalRequest command purpose", item.purpose, limits.approvalDetailChars);
    assertTextLimit("Plan approvalRequest command expectedEffect", item.expectedEffect, limits.approvalDetailChars);
  }
  for (const item of contract.changes) {
    assertTextLimit("Plan approvalRequest change target", item.target, limits.approvalPathChars);
    assertTextLimit("Plan approvalRequest change", item.change, limits.approvalDetailChars);
    assertTextLimit("Plan approvalRequest impact", item.impact, limits.approvalDetailChars);
  }
  for (const [label, items] of [
    ["alternatives", contract.alternatives || []],
    ["validation", contract.validation],
    ["rollback", contract.rollback],
    ["outOfScope", contract.outOfScope]
  ] as const) {
    if (items.length > 50) throw new Error(`Plan approvalRequest.${label} cannot contain more than 50 items.`);
    for (const item of items) assertTextLimit(`Plan approvalRequest.${label} item`, item, limits.approvalListItemChars);
  }
  assertTextLimit("Plan approvalRequest.requestedAt", contract.requestedAt, 80);
  assertTextLimit("Plan approvalRequest.sourceMessageId", contract.sourceMessageId, 240);
  assertTextLimit("Plan approvalRequest.feedbackId", contract.feedbackId, 240);
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
    if (step.isBlocked === true && !step.blockedBy?.trim()) {
      throw new Error("A blocked plan step must provide blockedBy.");
    }
    if (step.isBlocked === true && step.status !== "进行中") {
      throw new Error("Only the in-progress plan step can be blocked.");
    }
    if (step.approvalRequest) validateApprovalRequest(step.approvalRequest, limits);
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
  if (plan.status === "暂停" && (!plan.currentStepId || currentSteps.length !== 1 || currentSteps[0]?.id !== plan.currentStepId)) {
    throw new Error("A paused plan must preserve currentStepId for its only in-progress resume step.");
  }
  if (plan.status !== "进行中" && plan.status !== "暂停" && plan.currentStepId) {
    throw new Error("Only an in-progress or paused plan can provide currentStepId.");
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
  if (plan.isBlocked === true && !plan.blockedBy?.trim()) {
    throw new Error("A blocked plan must provide blockedBy.");
  }
  if (plan.isBlocked === true && plan.status !== "进行中") {
    throw new Error("Only an in-progress plan can be blocked.");
  }
  assertTextLimit("Plan source.summary", plan.source?.summary, limits.sourceSummaryChars);
  assertTextLimit("Plan taskBinding.sessionId", plan.taskBinding?.sessionId, 240);
  assertTextLimit("Plan taskBinding.sessionTitle", plan.taskBinding?.sessionTitle, 240);
  assertTextLimit("Plan taskBinding.workspace", plan.taskBinding?.workspace, 1000);
  assertTextLimit("Plan taskBinding.completionHook.gatewayId", plan.taskBinding?.completionHook?.gatewayId, 120);
  assertKeywordLimits("Plan", plan.keywords, limits.maxKeywords, limits.keywordChars);
  validatePlanSteps(plan, limits, requireSteps);
  const approvalGate = planApprovalGate(plan);
  if (approvalGate.state === "pending") {
    const step = currentPlanStep(plan);
    if (plan.isBlocked !== true || step?.isBlocked !== true) {
      throw new Error("Manager must derive isBlocked=true from a complete pending approval contract.");
    }
    if (!planBlockingReason(plan)) {
      throw new Error("An approval-blocked plan must identify the approver and requested decision.");
    }
  } else if (plan.isBlocked === true || plan.steps.some((step) => step.isBlocked === true)) {
    throw new Error("isBlocked is Manager-derived and is only valid for a complete pending approval contract.");
  }
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

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeApprovalRequest(value: unknown): PlanApprovalRequest | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const files = Array.isArray(raw.files) ? raw.files.flatMap<PlanApprovalFileChange>((value) => {
    const item = recordValue(value);
    const action = item.action === "create" || item.action === "delete" || item.action === "move" ? item.action : "modify";
    return [{
      path: String(item.path || "").trim(),
      action,
      change: String(item.change || item.summary || "").trim(),
      destination: typeof item.destination === "string" ? item.destination.trim() || undefined : undefined
    }];
  }) : [];
  const commands = Array.isArray(raw.commands) ? raw.commands.flatMap<PlanApprovalCommand>((value) => {
    const item = recordValue(value);
    return [{
      command: String(item.command || "").trim(),
      purpose: String(item.purpose || "").trim(),
      expectedEffect: typeof item.expectedEffect === "string" ? item.expectedEffect.trim() || undefined : undefined
    }];
  }) : [];
  const changes = Array.isArray(raw.changes) ? raw.changes.flatMap<PlanApprovalExternalChange>((value) => {
    const item = recordValue(value);
    return [{
      target: String(item.target || "").trim(),
      change: String(item.change || item.summary || "").trim(),
      impact: typeof item.impact === "string" ? item.impact.trim() || undefined : undefined
    }];
  }) : [];
  return {
    approver: typeof raw.approver === "string" ? raw.approver.trim() || undefined : undefined,
    request: String(raw.request || "").trim(),
    recommendation: typeof raw.recommendation === "string" ? raw.recommendation.trim() || undefined : undefined,
    alternatives: normalizedStringList(raw.alternatives),
    reason: String(raw.reason || "").trim(),
    files,
    commands,
    changes,
    validation: normalizedStringList(raw.validation),
    rollback: normalizedStringList(raw.rollback),
    outOfScope: normalizedStringList(raw.outOfScope),
    requestedAt: typeof raw.requestedAt === "string" ? raw.requestedAt.trim() || undefined : undefined,
    sourceMessageId: typeof raw.sourceMessageId === "string" ? raw.sourceMessageId.trim() || undefined : undefined,
    feedbackId: typeof raw.feedbackId === "string" ? raw.feedbackId.trim() || undefined : undefined,
    responseStatus: raw.responseStatus === "approved"
      || raw.responseStatus === "rejected"
      || raw.responseStatus === "changes_requested"
      || raw.responseStatus === "cancelled"
      ? raw.responseStatus
      : raw.responseStatus === "pending"
        ? "pending"
        : undefined
  };
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
      isBlocked: typeof raw.isBlocked === "boolean" ? raw.isBlocked : undefined,
      blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
      approvalRequest: normalizeApprovalRequest(raw.approvalRequest)
    }];
  });
}

export function planIsBlocked(plan: PlanItem): boolean {
  return planApprovalGate(plan).state === "pending";
}

export function planBlockingReason(plan: PlanItem): string {
  const step = currentPlanStep(plan);
  const explicit = step?.blockedBy?.trim() || plan.blockedBy?.trim();
  if (explicit) return explicit;
  const contract = planApprovalGate(plan).contract;
  if (!contract) return "";
  const approver = contract.approver?.trim() || "审批人";
  return `等待${approver}审批：${contract.request.trim()}`;
}

function withDerivedPlanBlockingState(plan: PlanItem): PlanItem {
  const blocked = planIsBlocked(plan);
  const currentStepId = currentPlanStep(plan)?.id;
  const derivedReason = blocked ? planBlockingReason(plan) : "";
  return {
    ...plan,
    isBlocked: blocked ? true : undefined,
    blockedBy: blocked && !plan.blockedBy?.trim() ? derivedReason : plan.blockedBy,
    steps: plan.steps.map((step) => ({
      ...step,
      isBlocked: blocked && step.id === currentStepId ? true : undefined,
      blockedBy: blocked && step.id === currentStepId && !step.blockedBy?.trim()
        ? derivedReason
        : step.blockedBy
    }))
  };
}

function recordPlanStepTimes(steps: PlanStep[], previousSteps: PlanStep[], recordedAt: string): PlanStep[] {
  const previousById = new Map(previousSteps.map((step) => [step.id, step]));
  return steps.map((step) => {
    const previous = previousById.get(step.id);
    if (step.status === "未开始") {
      return { ...step, startedAt: undefined, completedAt: undefined };
    }
    if (step.status === "进行中") {
      return {
        ...step,
        startedAt: step.startedAt || previous?.startedAt || recordedAt,
        completedAt: undefined
      };
    }
    const completedAt = step.completedAt || previous?.completedAt || recordedAt;
    return {
      ...step,
      startedAt: step.startedAt || previous?.startedAt || completedAt,
      completedAt
    };
  });
}

function validatePlanTaskBindingInput(value: unknown): void {
  if (value == null) return;
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) throw new Error("Plan taskBinding must be an object with a Codex sessionId.");
  if (raw.agentType != null && raw.agentType !== "codex") {
    throw new Error(`Unsupported plan taskBinding agentType: ${String(raw.agentType)}`);
  }
  if (!String(raw.sessionId || "").trim()) throw new Error("Plan taskBinding.sessionId is required.");
  if (raw.completionHook != null) {
    const hook = recordValue(raw.completionHook);
    if (Object.keys(hook).length === 0) throw new Error("Plan taskBinding.completionHook must be an object.");
    if (typeof hook.enabled !== "boolean") throw new Error("Plan taskBinding.completionHook.enabled must be boolean.");
  }
}

function validatePlanSecretaryBindingInput(value: unknown): void {
  if (value == null) return;
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) throw new Error("Plan secretaryBinding must identify a configured Codex secretary task.");
  if (raw.agentType != null && raw.agentType !== "codex") {
    throw new Error(`Unsupported plan secretaryBinding agentType: ${String(raw.agentType)}`);
  }
  if (!String(raw.sessionId || "").trim()) throw new Error("Plan secretaryBinding.sessionId is required.");
  if (!String(raw.workspace || "").trim()) throw new Error("Plan secretaryBinding.workspace is required.");
}

function normalizePlanSecretaryBinding(value: unknown): PlanSecretaryBinding | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const sessionId = String(raw.sessionId || "").trim();
  const workspace = String(raw.workspace || "").trim();
  if (!sessionId || !workspace) return undefined;
  return {
    agentType: "codex",
    sessionId,
    sessionTitle: typeof raw.sessionTitle === "string" ? raw.sessionTitle.trim() || undefined : undefined,
    workspace,
    assignedAt: typeof raw.assignedAt === "string" ? raw.assignedAt.trim() || undefined : undefined
  };
}

function normalizePlanTaskBinding(value: unknown): PlanTaskBinding | undefined {
  if (value == null) return undefined;
  const raw = recordValue(value);
  const sessionId = String(raw.sessionId || "").trim();
  if (!sessionId) return undefined;
  const hook = recordValue(raw.completionHook);
  return {
    agentType: "codex",
    sessionId,
    sessionTitle: typeof raw.sessionTitle === "string" ? raw.sessionTitle.trim() || undefined : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace.trim() || undefined : undefined,
    completionHook: {
      enabled: hook.enabled !== false,
      gatewayId: typeof hook.gatewayId === "string" ? hook.gatewayId.trim() || undefined : undefined
    }
  };
}

function normalizePlan(raw: Partial<PlanItem> & Record<string, unknown>, fallbackId?: string): PlanItem | null {
  const title = String(raw.title || "").trim();
  if (!title) return null;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  const status: PlanStatus = raw.status === "未开始" || raw.status === "进行中" || raw.status === "暂停" || raw.status === "已完成" || raw.status === "已归档"
    ? raw.status
    : "未开始";
  return withDerivedPlanBlockingState({
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
    isBlocked: typeof raw.isBlocked === "boolean" ? raw.isBlocked : undefined,
    blockedBy: typeof raw.blockedBy === "string" ? raw.blockedBy : undefined,
    attachments: normalizeStoredPlanAttachments(raw.attachments),
    steps: normalizePlanSteps(raw.steps),
    project: raw.project && typeof raw.project === "object" && !Array.isArray(raw.project) ? raw.project as PlanItem["project"] : undefined,
    source: raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as KnowledgeSource : undefined,
    secretaryBinding: normalizePlanSecretaryBinding(raw.secretaryBinding),
    taskBinding: normalizePlanTaskBinding(raw.taskBinding),
    dueAt: typeof raw.dueAt === "string" ? raw.dueAt : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
    keywords: normalizeKeywords(raw.keywords)
  });
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
    recalledAt: typeof raw.recalledAt === "string" ? raw.recalledAt : undefined,
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
    recalledAt: typeof raw.recalledAt === "string" ? raw.recalledAt : undefined,
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
  return path.join(memoryDir(roleDir), "recent", `${safeIdPart(memory.id) || "memory"}.md`);
}

function consolidatedMemoryFile(roleDir: string, memory: ConsolidatedMemoryItem): string {
  return path.join(memoryDir(roleDir), "consolidated", `${safeIdPart(memory.id) || "consolidated-memory"}.md`);
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

type PlanListCacheEntry = {
  signature: string;
  validUntil: number;
  plans: PlanItem[];
};

type PlanFileCacheEntry = {
  size: number;
  mtimeMs: number;
  plan: PlanItem | null;
};

const PLAN_LIST_CACHE_TTL_MS = 500;
const PLAN_LIST_WATCH_DEBOUNCE_MS = 120;
const planListCache = new Map<string, PlanListCacheEntry>();
const planFileCache = new Map<string, Map<string, PlanFileCacheEntry>>();
const planListWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const planListDirtyAt = new Map<string, number>();
const planListDirtyFiles = new Map<string, Set<string> | null>();
const planListRefreshTimers = new Map<string, NodeJS.Timeout>();
const planListRefreshInFlight = new Set<string>();

function planListCacheKey(roleDir: string): string {
  return path.resolve(roleDir);
}

function clearPlanListCache(roleDir: string): void {
  const cacheKey = planListCacheKey(roleDir);
  planListCache.delete(cacheKey);
  planFileCache.delete(cacheKey);
  planListDirtyAt.delete(cacheKey);
  planListDirtyFiles.delete(cacheKey);
  const timer = planListRefreshTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  planListRefreshTimers.delete(cacheKey);
  const watchers = planListWatchers.get(cacheKey);
  for (const watcher of watchers?.values() || []) watcher.close();
  planListWatchers.delete(cacheKey);
}

function markPlanListCacheDirty(roleDir: string, filePath?: string): void {
  const cacheKey = planListCacheKey(roleDir);
  planListDirtyAt.set(cacheKey, Date.now());
  if (!filePath) {
    planListDirtyFiles.set(cacheKey, null);
    return;
  }
  const current = planListDirtyFiles.get(cacheKey);
  if (current === null) return;
  const dirtyFiles = current || new Set<string>();
  dirtyFiles.add(path.resolve(filePath));
  planListDirtyFiles.set(cacheKey, dirtyFiles);
  schedulePlanListCacheRefresh(roleDir);
}

function readPlansWithFileCache(roleDir: string, files: string[]): { signature: string; items: PlanItem[] } {
  const cacheKey = planListCacheKey(roleDir);
  let cachedFiles = planFileCache.get(cacheKey);
  if (!cachedFiles) {
    cachedFiles = new Map<string, PlanFileCacheEntry>();
    planFileCache.set(cacheKey, cachedFiles);
  }
  const resolvedFiles = files.map((filePath) => path.resolve(filePath));
  const currentFiles = new Set(resolvedFiles);
  for (const filePath of cachedFiles.keys()) {
    if (!currentFiles.has(filePath)) cachedFiles.delete(filePath);
  }
  const signatureParts: string[] = [];
  const items: PlanItem[] = [];
  for (const filePath of resolvedFiles) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cachedFiles.delete(filePath);
      signatureParts.push(`${filePath}\u001fmissing`);
      continue;
    }
    signatureParts.push(`${filePath}\u001f${stat.size}\u001f${stat.mtimeMs}`);
    let cachedFile = cachedFiles.get(filePath);
    if (!cachedFile || cachedFile.size !== stat.size || cachedFile.mtimeMs !== stat.mtimeMs) {
      const raw = readJson<Record<string, unknown>>(filePath);
      cachedFile = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        plan: raw ? normalizePlan(raw, path.basename(filePath, ".json")) : null
      };
      cachedFiles.set(filePath, cachedFile);
    }
    if (cachedFile.plan) items.push(cachedFile.plan);
  }
  return { signature: signatureParts.join("\u001e"), items };
}

function plansFromFileCache(roleDir: string): { signature: string; items: PlanItem[] } | null {
  const cachedFiles = planFileCache.get(planListCacheKey(roleDir));
  if (!cachedFiles) return null;
  const activePrefix = `${path.resolve(path.join(plansDir(roleDir), "items", "active"))}${path.sep}`;
  const entries = [...cachedFiles.entries()].sort(([left], [right]) => {
    const priorityDelta = Number(!left.startsWith(activePrefix)) - Number(!right.startsWith(activePrefix));
    return priorityDelta || left.localeCompare(right);
  });
  return {
    signature: entries.map(([filePath, entry]) => `${filePath}\u001f${entry.size}\u001f${entry.mtimeMs}`).join("\u001e"),
    items: entries.flatMap(([, entry]) => entry.plan ? [entry.plan] : [])
  };
}

function uniquePlans(items: PlanItem[]): PlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

type AsyncPlanFileCacheResult = {
  filePath: string;
  entry?: PlanFileCacheEntry;
  missing?: boolean;
  retry?: boolean;
};

async function readChangedPlanFile(filePath: string, retryOnTransient = true): Promise<AsyncPlanFileCacheResult> {
  try {
    const [stat, text] = await Promise.all([
      fs.promises.stat(filePath),
      fs.promises.readFile(filePath, "utf8")
    ]);
    const after = await fs.promises.stat(filePath);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      return { filePath, retry: true };
    }
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (retryOnTransient) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return readChangedPlanFile(filePath, false);
      }
    }
    return {
      filePath,
      entry: {
        size: after.size,
        mtimeMs: after.mtimeMs,
        plan: raw ? normalizePlan(raw, path.basename(filePath, ".json")) : null
      }
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? { filePath, missing: true } : { filePath, retry: true };
  }
}

function schedulePlanListCacheRefresh(roleDir: string): void {
  const cacheKey = planListCacheKey(roleDir);
  const current = planListRefreshTimers.get(cacheKey);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    planListRefreshTimers.delete(cacheKey);
    void refreshPlanListCacheFromDirtyFiles(roleDir);
  }, PLAN_LIST_WATCH_DEBOUNCE_MS);
  timer.unref?.();
  planListRefreshTimers.set(cacheKey, timer);
}

async function refreshPlanListCacheFromDirtyFiles(roleDir: string): Promise<void> {
  const cacheKey = planListCacheKey(roleDir);
  if (planListRefreshInFlight.has(cacheKey)) return;
  const dirtyFiles = planListDirtyFiles.get(cacheKey);
  const cachedFiles = planFileCache.get(cacheKey);
  if (!(dirtyFiles instanceof Set) || !dirtyFiles.size || !cachedFiles || !planListCache.has(cacheKey)) return;
  planListDirtyFiles.delete(cacheKey);
  planListDirtyAt.delete(cacheKey);
  planListRefreshInFlight.add(cacheKey);
  try {
    const results = await Promise.all([...dirtyFiles].map((filePath) => readChangedPlanFile(filePath)));
    for (const result of results) {
      if (result.missing) cachedFiles.delete(result.filePath);
      else if (result.entry) cachedFiles.set(result.filePath, result.entry);
      else if (result.retry) markPlanListCacheDirty(roleDir, result.filePath);
    }
    const refreshed = plansFromFileCache(roleDir);
    if (refreshed) {
      planListCache.set(cacheKey, {
        signature: refreshed.signature,
        validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
        plans: uniquePlans(refreshed.items)
      });
    }
  } finally {
    planListRefreshInFlight.delete(cacheKey);
    if (planListDirtyFiles.get(cacheKey) instanceof Set && !planListRefreshTimers.has(cacheKey)) {
      schedulePlanListCacheRefresh(roleDir);
    }
  }
}

function updatePlanListCacheAfterWrite(
  roleDir: string,
  destination: string,
  plan: PlanItem,
  relatedFiles: string[]
): void {
  const cacheKey = planListCacheKey(roleDir);
  const cachedFiles = planFileCache.get(cacheKey);
  if (!cachedFiles || !planListCache.has(cacheKey)) {
    clearPlanListCache(roleDir);
    return;
  }
  const resolvedFiles = [...new Set(relatedFiles.map((filePath) => path.resolve(filePath)))];
  for (const filePath of resolvedFiles) cachedFiles.delete(filePath);
  const resolvedDestination = path.resolve(destination);
  try {
    const stat = fs.statSync(resolvedDestination);
    cachedFiles.set(resolvedDestination, { size: stat.size, mtimeMs: stat.mtimeMs, plan });
  } catch {
    clearPlanListCache(roleDir);
    return;
  }
  const refreshed = plansFromFileCache(roleDir);
  if (!refreshed) {
    clearPlanListCache(roleDir);
    return;
  }
  planListCache.set(cacheKey, {
    signature: refreshed.signature,
    validUntil: Date.now() + PLAN_LIST_CACHE_TTL_MS,
    plans: uniquePlans(refreshed.items)
  });
  const dirtyFiles = planListDirtyFiles.get(cacheKey);
  if (dirtyFiles instanceof Set) {
    for (const filePath of resolvedFiles) dirtyFiles.delete(filePath);
    dirtyFiles.delete(resolvedDestination);
    if (!dirtyFiles.size) {
      planListDirtyFiles.delete(cacheKey);
      planListDirtyAt.delete(cacheKey);
    }
  }
}

function ensurePlanListWatchers(roleDir: string): boolean {
  const cacheKey = planListCacheKey(roleDir);
  const directories = [
    path.join(plansDir(roleDir), "items", "active"),
    path.join(plansDir(roleDir), "archive")
  ].filter((directory) => fs.existsSync(directory));
  if (!directories.length) return false;
  let watchers = planListWatchers.get(cacheKey);
  if (!watchers) {
    watchers = new Map<string, fs.FSWatcher>();
    planListWatchers.set(cacheKey, watchers);
  }
  for (const directory of directories) {
    if (watchers.has(directory)) continue;
    try {
      const watcher = fs.watch(directory, { persistent: false }, (_eventType, fileName) => {
        if (!fs.existsSync(directory)) {
          watcher.close();
          watchers?.delete(directory);
          markPlanListCacheDirty(roleDir);
          return;
        }
        if (!fileName) {
          markPlanListCacheDirty(roleDir);
          return;
        }
        const relativeName = fileName.toString();
        if (!relativeName.toLowerCase().endsWith(".json")) return;
        markPlanListCacheDirty(roleDir, path.join(directory, relativeName));
      });
      watcher.unref();
      watcher.on("error", () => {
        watcher.close();
        watchers?.delete(directory);
        markPlanListCacheDirty(roleDir);
      });
      watchers.set(directory, watcher);
    } catch {
      // Fall back to the short signature TTL when this filesystem cannot be watched.
    }
  }
  return directories.every((directory) => watchers?.has(directory));
}

type PlanRecord = {
  filePath: string;
  plan: PlanItem;
};

function planCandidateFiles(roleDir: string, planId: string): string[] {
  const fileName = `${safeIdPart(planId) || "plan"}.json`;
  return [
    path.join(plansDir(roleDir), "items", "active", fileName),
    path.join(plansDir(roleDir), "archive", fileName)
  ];
}

function planRecordFromFile(filePath: string, planId: string): PlanRecord | null {
  const raw = readJson<Record<string, unknown>>(filePath);
  const plan = raw ? normalizePlan(raw, path.basename(filePath, ".json")) : null;
  return plan?.id === planId ? { filePath, plan } : null;
}

function findPlanRecord(roleDir: string, planId: string): PlanRecord | null {
  const candidates = planCandidateFiles(roleDir, planId);
  for (const filePath of candidates) {
    const record = planRecordFromFile(filePath, planId);
    if (record) return record;
  }
  const candidateSet = new Set(candidates.map((filePath) => path.resolve(filePath)));
  for (const filePath of allPlanFiles(roleDir)) {
    if (candidateSet.has(path.resolve(filePath))) continue;
    const record = planRecordFromFile(filePath, planId);
    if (record) return record;
  }
  return null;
}

export function listPlans(roleDir: string): PlanItem[] {
  const cacheKey = planListCacheKey(roleDir);
  const now = Date.now();
  const cached = planListCache.get(cacheKey);
  const watchBacked = ensurePlanListWatchers(roleDir);
  const dirtyAt = planListDirtyAt.get(cacheKey);
  if (cached && watchBacked && dirtyAt === undefined) return cached.plans;
  if (cached && watchBacked && dirtyAt !== undefined) {
    if (planListDirtyFiles.get(cacheKey) instanceof Set) {
      if (!planListRefreshTimers.has(cacheKey)) schedulePlanListCacheRefresh(roleDir);
      return cached.plans;
    }
  }
  if (cached && !watchBacked && cached.validUntil > now) return cached.plans;
  const files = allPlanFiles(roleDir);
  const { signature, items } = readPlansWithFileCache(roleDir, files);
  if (cached && cached.signature === signature) {
    cached.validUntil = now + PLAN_LIST_CACHE_TTL_MS;
    planListDirtyAt.delete(cacheKey);
    planListDirtyFiles.delete(cacheKey);
    return cached.plans;
  }
  const plans = uniquePlans(items);
  planListCache.set(cacheKey, { signature, validUntil: now + PLAN_LIST_CACHE_TTL_MS, plans });
  planListDirtyAt.delete(cacheKey);
  planListDirtyFiles.delete(cacheKey);
  return plans;
}

export function getPlan(roleDir: string, planId: string): PlanItem | null {
  return findPlanRecord(roleDir, planId)?.plan ?? null;
}

type MemoryCatalogItem = RecentMemoryItem | ConsolidatedMemoryItem;
type MemoryCatalogCacheEntry = { validUntil: number; items: MemoryCatalogItem[] };
const MEMORY_CATALOG_CACHE_TTL_MS = 500;
const memoryCatalogCache = new Map<string, MemoryCatalogCacheEntry>();
const memoryCatalogWatchers = new Map<string, fs.FSWatcher>();

function memoryCatalogDirectory(roleDir: string, kind: "recent" | "consolidated"): string {
  return path.resolve(memoryDir(roleDir), kind);
}

function invalidateMemoryCatalog(directory: string): void {
  const cacheKey = path.resolve(directory);
  memoryCatalogCache.delete(cacheKey);
  recentMemoryConsolidationProjectionCache.delete(cacheKey);
}

function ensureMemoryCatalogWatcher(directory: string): boolean {
  const cacheKey = path.resolve(directory);
  if (memoryCatalogWatchers.has(cacheKey)) return true;
  if (!fs.existsSync(cacheKey)) return false;
  try {
    const watcher = fs.watch(cacheKey, { persistent: false }, (_eventType, fileName) => {
      if (!fs.existsSync(cacheKey)) {
        watcher.close();
        memoryCatalogWatchers.delete(cacheKey);
        invalidateMemoryCatalog(cacheKey);
        return;
      }
      if (fileName && !/\.(?:json|md)$/i.test(fileName.toString())) return;
      invalidateMemoryCatalog(cacheKey);
    });
    watcher.unref();
    watcher.on("error", () => {
      watcher.close();
      memoryCatalogWatchers.delete(cacheKey);
      invalidateMemoryCatalog(cacheKey);
    });
    memoryCatalogWatchers.set(cacheKey, watcher);
    return true;
  } catch {
    return false;
  }
}

function listMemoryCatalog<T extends MemoryCatalogItem>(
  directory: string,
  normalize: (raw: Record<string, unknown>, fallbackId: string) => T | null
): T[] {
  const cacheKey = path.resolve(directory);
  const cached = memoryCatalogCache.get(cacheKey);
  const watchBacked = ensureMemoryCatalogWatcher(cacheKey);
  if (cached && (watchBacked || cached.validUntil > Date.now())) return cached.items as T[];
  const items: T[] = [];
  const seen = new Set<string>();
  for (const file of [...markdownFiles(cacheKey), ...jsonFiles(cacheKey)]) {
    const markdown = file.toLowerCase().endsWith(".md");
    const raw = markdown ? parseMemoryMarkdown(file) : readJson<Record<string, unknown>>(file);
    const item = raw ? normalize(raw, path.basename(file, path.extname(file))) : null;
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  memoryCatalogCache.set(cacheKey, { validUntil: Date.now() + MEMORY_CATALOG_CACHE_TTL_MS, items });
  return items;
}

function writeMemoryCatalog(filePath: string, value: RecentMemoryItem | ConsolidatedMemoryItem): void {
  writeMemoryMarkdown(filePath, value);
  invalidateMemoryCatalog(path.dirname(filePath));
}

type MemoryCatalogWrite = {
  filePath: string;
  value: RecentMemoryItem | ConsolidatedMemoryItem;
};

const MEMORY_CATALOG_WRITE_WORKER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
try {
  for (const directory of new Set(workerData.map((entry) => path.dirname(entry.filePath)))) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const entry of workerData) fs.writeFileSync(entry.filePath, entry.content, "utf8");
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
`;

async function writeMemoryCatalogBatch(entries: MemoryCatalogWrite[]): Promise<void> {
  if (entries.length === 0) return;
  const directories = [...new Set(entries.map((entry) => path.dirname(entry.filePath)))];
  const writes = entries.map((entry) => ({ filePath: entry.filePath, content: memoryMarkdown(entry.value) }));
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(MEMORY_CATALOG_WRITE_WORKER_SOURCE, { eval: true, workerData: writes });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    worker.once("message", (message: { ok?: boolean; message?: string }) => {
      if (message?.ok !== true) {
        fail(new Error(message?.message || "Memory catalog write worker failed."));
        return;
      }
      if (settled) return;
      settled = true;
      resolve();
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (code !== 0) fail(new Error(`Memory catalog write worker exited with code ${code}.`));
    });
  });
  for (const directory of directories) invalidateMemoryCatalog(directory);
}

export function listRecentMemories(roleDir: string): RecentMemoryItem[] {
  return listMemoryCatalog(memoryCatalogDirectory(roleDir, "recent"), normalizeRecentMemory);
}

export function listActiveRecentMemories(roleDir: string): RecentMemoryItem[] {
  return listRecentMemories(roleDir).filter((memory) => !memory.consolidatedAt);
}

export function listArchivedMemories(roleDir: string): RecentMemoryItem[] {
  return listRecentMemories(roleDir).filter((memory) => Boolean(memory.consolidatedAt));
}

export function getRecentMemory(roleDir: string, memoryId: string): RecentMemoryItem | undefined {
  const memory = listRecentMemories(roleDir).find((item) => item.id === memoryId);
  if (!memory) return undefined;
  const viewed = { ...memory, viewedAt: nowIso() };
  writeMemoryCatalog(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

function touchRecentMemoryView(roleDir: string, memory: RecentMemoryItem, viewedAt = nowIso()): RecentMemoryItem {
  const viewed = { ...memory, viewedAt, recalledAt: viewedAt };
  writeMemoryCatalog(recentMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidatedMemories(roleDir: string): ConsolidatedMemoryItem[] {
  return listMemoryCatalog(memoryCatalogDirectory(roleDir, "consolidated"), normalizeConsolidatedMemory);
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
  writeMemoryCatalog(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

function touchConsolidatedMemoryView(roleDir: string, memory: ConsolidatedMemoryItem, viewedAt = nowIso()): ConsolidatedMemoryItem {
  const viewed = { ...memory, viewedAt, recalledAt: viewedAt };
  writeMemoryCatalog(consolidatedMemoryFile(roleDir, viewed), viewed);
  return viewed;
}

export function listConsolidationRuns(roleDir: string): MemoryConsolidationRun[] {
  return jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).flatMap((file) => {
    const raw = readJson<MemoryConsolidationRun>(file);
    return raw ? [raw] : [];
  });
}

export function roleMemoryCounts(roleDir: string): {
  recent: number;
  consolidated: number;
  archived: number;
  consolidationRuns: number;
} {
  const recentMemories = listRecentMemories(roleDir);
  return {
    recent: recentMemories.filter((memory) => !memory.consolidatedAt).length,
    consolidated: listConsolidatedMemories(roleDir).length,
    archived: recentMemories.filter((memory) => Boolean(memory.consolidatedAt)).length,
    consolidationRuns: jsonFiles(path.join(memoryDir(roleDir), "consolidation-runs")).length
  };
}

export function createPlan(roleDir: string, input: Record<string, unknown>): PlanItem {
  if (!String(input.focus || "").trim()) throw new Error("Plan focus is required and must describe one subject.");
  validatePlanSecretaryBindingInput(input.secretaryBinding);
  validatePlanTaskBindingInput(input.taskBinding);
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("plan", String(input.title || ""));
  const recordedAt = nowIso();
  const plan = normalizePlan({ ...input, attachments: [], id, createdAt: recordedAt, updatedAt: recordedAt });
  if (!plan) throw new Error("Plan title is required.");
  plan.steps = recordPlanStepTimes(plan.steps, [], recordedAt);
  requireKeywords(plan.keywords, "Plan");
  validatePlanWrite(roleDir, plan, true);
  if (Object.prototype.hasOwnProperty.call(input, "attachments")) {
    plan.attachments = storePlanAttachments(roleDir, plan.id, input.attachments);
  }
  const destination = planFile(roleDir, plan);
  writeJson(destination, plan);
  updatePlanListCacheAfterWrite(roleDir, destination, plan, [destination]);
  return plan;
}

export function updatePlan(roleDir: string, planId: string, patch: Record<string, unknown>): PlanItem {
  const record = findPlanRecord(roleDir, planId);
  if (!record) throw new Error(`Plan not found: ${planId}`);
  const existing = record.plan;
  if (Object.prototype.hasOwnProperty.call(patch, "secretaryBinding")) validatePlanSecretaryBindingInput(patch.secretaryBinding);
  if (Object.prototype.hasOwnProperty.call(patch, "taskBinding")) validatePlanTaskBindingInput(patch.taskBinding);
  const recordedAt = nowIso();
  const next = normalizePlan({ ...existing, ...patch, attachments: existing.attachments, id: existing.id, createdAt: existing.createdAt, updatedAt: recordedAt });
  if (!next) throw new Error("Plan title is required.");
  next.steps = recordPlanStepTimes(next.steps, existing.steps, recordedAt);
  requireKeywords(next.keywords, "Plan");
  validatePlanWrite(roleDir, next);
  if (Object.prototype.hasOwnProperty.call(patch, "attachments")) {
    next.attachments = storePlanAttachments(roleDir, next.id, patch.attachments, existing.attachments);
  }
  if (next.status === "已完成" && existing.status !== "已完成" && !next.completedAt) {
    next.completedAt = next.updatedAt;
  }
  const destination = planFile(roleDir, next);
  writeJson(destination, next);
  for (const filePath of new Set([record.filePath, ...planCandidateFiles(roleDir, planId)])) {
    if (path.resolve(filePath) === path.resolve(destination)) continue;
    const raw = readJson<Record<string, unknown>>(filePath);
    if (raw?.id !== planId) continue;
    try { fs.unlinkSync(filePath); } catch { /* ignore stale file */ }
  }
  updatePlanListCacheAfterWrite(
    roleDir,
    destination,
    next,
    [destination, record.filePath, ...planCandidateFiles(roleDir, planId)]
  );
  notifyPlanUpdated({ roleDir: path.resolve(roleDir), before: existing, after: next });
  return next;
}

export function createRecentMemory(roleDir: string, input: Record<string, unknown>): RecentMemoryItem {
  if (!String(input.focus || "").trim()) throw new Error("Memory focus is required and must describe one subject.");
  const id = typeof input.id === "string" && input.id.trim() ? input.id : generatedId("memory", String(input.title || ""));
  const memory = normalizeRecentMemory({ ...input, id, createdAt: nowIso(), updatedAt: nowIso() });
  if (!memory) throw new Error("Memory title and content are required.");
  requireKeywords(memory.keywords, "Memory");
  validateMemoryWrite(roleDir, memory);
  writeMemoryCatalog(recentMemoryFile(roleDir, memory), memory);
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
  writeMemoryCatalog(recentMemoryFile(roleDir, next), next);
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
  const cohort = recentMemoryConsolidationCohort(memories, recentEditableHours, recentConsolidationHours);
  const triggerAt = Date.parse(cohort.trigger?.consolidationTriggerAt || "");
  const shouldTrigger = force || (Number.isFinite(triggerAt) && Date.now() >= triggerAt);
  if (!shouldTrigger) return null;

  const input = force
    ? memories.filter((item) => ageHours(memoryConsolidationActivityAt(item)) > recentEditableHours)
    : cohort.candidates;
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
    triggerMemoryId: cohort.trigger?.memory.id,
    triggerAt: cohort.trigger?.consolidationTriggerAt,
    candidateCutoffAt: force
      ? new Date(Date.now() - recentEditableHours * 3_600_000).toISOString()
      : cohort.candidateCutoffAt,
    inputMemoryIds: inputIds,
    status: "requested",
    instruction: "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。"
  };
  writeJson(consolidationRunFile(roleDir, run.id), run);
  return { run, memories: input };
}

export function nextMemoryConsolidationTriggerAt(
  roleDir: string,
  recentEditableHours = DEFAULT_RECENT_EDITABLE_HOURS,
  recentConsolidationHours = DEFAULT_RECENT_CONSOLIDATION_HOURS
): number | undefined {
  const memories = listRecentMemories(roleDir).filter((item) => !item.consolidatedAt);
  const cohort = recentMemoryConsolidationCohort(memories, recentEditableHours, recentConsolidationHours);
  const triggerAt = Date.parse(cohort.trigger?.consolidationTriggerAt || "");
  return Number.isFinite(triggerAt) ? triggerAt : undefined;
}

export function markMemoryConsolidationRunDelivered(
  roleDir: string,
  runId: string,
  deliveredAt = nowIso()
): MemoryConsolidationRun {
  const run = readJson<MemoryConsolidationRun>(consolidationRunFile(roleDir, runId));
  if (!run) throw new Error(`Memory consolidation run not found: ${runId}`);
  if (run.deliveredAt || run.status === "completed") return run;
  const delivered = { ...run, deliveredAt };
  writeJson(consolidationRunFile(roleDir, runId), delivered);
  return delivered;
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

type MemoryConsolidationCompletionResult = {
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
};

const memoryConsolidationCompletions = new Map<string, Promise<MemoryConsolidationCompletionResult>>();

async function completeMemoryConsolidationUnlocked(
  roleDir: string,
  runId: string,
  rawItems: unknown
): Promise<MemoryConsolidationCompletionResult> {
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

  const completedAt = nowIso();
  const inputMemoryIds = new Set(run.inputMemoryIds);
  const recentWrites = listRecentMemories(roleDir)
    .filter((item) => inputMemoryIds.has(item.id))
    .map((memory) => ({
      filePath: recentMemoryFile(roleDir, memory),
      value: {
      ...memory,
      consolidatedAt: completedAt,
      consolidationRunId: run.id
      }
    } satisfies MemoryCatalogWrite));
  const outputWrites = output.map((memory) => ({
    filePath: consolidatedMemoryFile(roleDir, memory),
    value: memory
  } satisfies MemoryCatalogWrite));
  await writeMemoryCatalogBatch([...outputWrites, ...recentWrites]);

  const completedRun: MemoryConsolidationRun = {
    ...run,
    completedAt,
    outputMemoryIds: output.map((item) => item.id),
    status: "completed"
  };
  writeJson(consolidationRunFile(roleDir, run.id), completedRun);

  return { run: completedRun, memories: output };
}

export function completeMemoryConsolidation(
  roleDir: string,
  runId: string,
  rawItems: unknown
): Promise<MemoryConsolidationCompletionResult> {
  const key = `${path.resolve(roleDir)}\u0000${runId}`;
  const active = memoryConsolidationCompletions.get(key);
  if (active) return active;
  const completion = completeMemoryConsolidationUnlocked(roleDir, runId, rawItems)
    .finally(() => {
      if (memoryConsolidationCompletions.get(key) === completion) {
        memoryConsolidationCompletions.delete(key);
      }
    });
  memoryConsolidationCompletions.set(key, completion);
  return completion;
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

export function applyMemoryConsolidationResult(roleDir: string, runId: string, body: Record<string, unknown>): Promise<{
  run: MemoryConsolidationRun;
  memories: ConsolidatedMemoryItem[];
}> {
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
  revisionAt: string;
  memory?: RecentMemoryItem | ConsolidatedMemoryItem;
  skill?: RoleSkillItem;
};

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
  if (options.archiveCompletedPlans !== false) archiveCompletedPlans(roleDir);
  const plans = listPlans(roleDir);
  const memories = listRecentMemories(roleDir);
  const consolidatedMemories = listConsolidatedMemories(roleDir);
  const skills = listRoleSkills(roleDir);
  const activePlans = plans.filter((item) => item.status === "进行中");
  const activeSkills = skills.filter((item) => item.status === "active");
  const recentMemories = memories.filter((item) => !item.consolidatedAt && ageHours(memoryActivityAt(item)) <= DEFAULT_RECENT_EDITABLE_HOURS);
  const roleId = options.roleId || path.basename(roleDir);
  const contextInjection = roleContextInjectionPolicy(roleDir);
  const recentMemoryIds = new Set(recentMemories.map((item) => item.id));
  const scoredCandidates: ScoredKnowledgeCandidate[] = [
    ...plans
      .filter((item) => item.status !== "已归档")
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.focus,
        type: "plan" as const,
        endpoint: requiredReadEndpoint(roleId, "plan", item.id),
        score: scoreKnowledgeMatch(messageText, item, item.status === "进行中" ? 5 : 0),
        activityAt: item.updatedAt,
        revisionAt: item.updatedAt
      })),
    ...memories
      .filter((item) => !item.consolidatedAt)
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.focus,
        type: "recent_memory" as const,
        endpoint: requiredReadEndpoint(roleId, "recent_memory", item.id),
        score: scoreKnowledgeMatch(messageText, item, recentMemoryIds.has(item.id) ? 5 : 0),
        activityAt: memoryActivityAt(item),
        revisionAt: item.updatedAt,
        memory: item
      })),
    ...consolidatedMemories.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.focus,
      type: "consolidated_memory" as const,
      endpoint: requiredReadEndpoint(roleId, "consolidated_memory", item.id),
      score: scoreKnowledgeMatch(messageText, item),
      activityAt: memoryActivityAt(item),
      revisionAt: item.updatedAt,
      memory: item
    })),
    ...skills
      .filter((item) => item.status !== "archived")
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        type: "role_skill" as const,
        endpoint: requiredReadEndpoint(roleId, "role_skill", item.id),
        score: scoreSkillMatch(messageText, item),
        activityAt: item.updatedAt,
        revisionAt: item.updatedAt,
        skill: item
      }))
  ].filter((item) => item.score > 0).sort(sortScoredCandidates);

  const requiredReadItems = scoredCandidates
    .slice(0, options.requiredReadLimit ?? contextInjection.requiredReadLimit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      type: item.type,
      endpoint: item.endpoint,
      score: item.score,
      revisionAt: item.revisionAt
    }));

  if (options.touchViewedAt !== false) {
    const touchedAt = nowIso();
    for (const item of requiredReadItems.filter((item) => options.touchRequiredRead?.(item) !== false)) {
      const candidate = scoredCandidates.find((candidateItem) => candidateItem.type === item.type && candidateItem.id === item.id);
      if (candidate?.type === "recent_memory" && candidate.memory) {
        touchRecentMemoryView(roleDir, candidate.memory as RecentMemoryItem, touchedAt);
      }
      if (candidate?.type === "consolidated_memory" && candidate.memory) {
        touchConsolidatedMemoryView(roleDir, candidate.memory as ConsolidatedMemoryItem, touchedAt);
      }
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
    matchedItems: scoredCandidates.slice(0, contextInjection.matchedItemLimit).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type
    })),
    matchedSkills: scoredCandidates
      .filter((item) => item.type === "role_skill" && item.skill)
      .slice(0, contextInjection.matchedItemLimit)
      .map((item) => item.skill as RoleSkillItem),
    requiredReadItems,
    contextInjection,
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
