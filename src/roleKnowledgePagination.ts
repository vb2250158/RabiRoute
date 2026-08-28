export type RolePlanPageCounts = {
  total: number;
  current: number;
  plans: number;
  archived: number;
  blocked: number;
  qa: number;
  active: number;
  stages: {
    executing: number;
    qa: number;
    waitingPackage: number;
    approval: number;
    manualVerification: number;
    paused: number;
    completed: number;
    archived: number;
  };
};

export type RolePlanPage<T> = {
  items: T[];
  total: number;
  nextCursor: string;
  counts: RolePlanPageCounts;
  facets: {
    statuses: Array<{
      status: string;
      count: number;
      palette: {
        accent: string;
        background: string;
        foreground: string;
      };
    }>;
    tags: Array<{
      tag: string;
      count: number;
    }>;
  };
};

export type RoleMemoryPageCounts = {
  recent: number;
  consolidated: number;
  archived: number;
  consolidationRuns: number;
};

export type RoleMemoryPage<T> = {
  items: T[];
  total: number;
  nextCursor: string;
  counts: RoleMemoryPageCounts;
};

type RolePlanSummarySource = PresentedPlanItem;

export type RolePlanSummary = ReturnType<typeof summarizeRolePlan>;
export type RolePlanPreview = ReturnType<typeof previewRolePlan>;

type PresentedPlanLike = {
  updatedAt: string;
  dueAt?: string;
  importance?: number;
  urgency?: number;
  priority?: string;
  keywords: string[];
  presentation: {
    status: string;
    tone: string;
    statusLevel: number;
    views: string[];
    palette: {
      accent: string;
      background: string;
      foreground: string;
    };
    importance: {
      level: number;
    };
    urgency: {
      level: number;
    };
  };
};

export type RolePlanPageFilter = {
  view?: string;
  query?: string;
  sort?: "status" | "updated" | "importance" | "urgency";
  statuses?: string[];
  tags?: string[];
  includeFacets?: boolean;
};

export const DEFAULT_ROLE_PLAN_PAGE_SIZE = 12;
export const MAX_ROLE_PLAN_PAGE_SIZE = 250;
export const DEFAULT_ROLE_MEMORY_PAGE_SIZE = 24;
export const MAX_ROLE_MEMORY_PAGE_SIZE = 100;

function cursorOffset(cursor: string): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid plan page cursor.");
  return Number(cursor);
}

export function normalizeRolePlanPageLimit(value: string | null): number {
  if (!value) return DEFAULT_ROLE_PLAN_PAGE_SIZE;
  if (!/^\d+$/.test(value)) throw new Error("Invalid plan page limit.");
  return Math.min(MAX_ROLE_PLAN_PAGE_SIZE, Math.max(1, Number(value)));
}

export function normalizeRoleMemoryPageLimit(value: string | null): number {
  if (!value) return DEFAULT_ROLE_MEMORY_PAGE_SIZE;
  if (!/^\d+$/.test(value)) throw new Error("Invalid memory page limit.");
  return Math.min(MAX_ROLE_MEMORY_PAGE_SIZE, Math.max(1, Number(value)));
}

function sortPlans<T extends PresentedPlanLike>(plans: T[], sort: RolePlanPageFilter["sort"]): T[] {
  if (sort === "updated") {
    return plans
      .map((plan, index) => ({ plan, index, value: new Date(plan.updatedAt).getTime() }))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.value) ? left.value : 0;
        const rightTime = Number.isFinite(right.value) ? right.value : 0;
        return rightTime - leftTime || left.index - right.index;
      })
      .map((item) => item.plan);
  }
  if (sort === "importance") {
    return plans
      .map((plan, index) => ({ plan, index, rank: plan.presentation.importance.level }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((item) => item.plan);
  }
  if (sort === "urgency") {
    return plans
      .map((plan, index) => ({ plan, index, rank: plan.presentation.urgency.level }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((item) => item.plan);
  }
  return plans;
}

export function paginateRolePlans<T extends PresentedPlanLike>(
  plans: T[],
  cursor: string,
  limit: number,
  filter: RolePlanPageFilter = {}
): RolePlanPage<T> {
  const offset = cursorOffset(cursor);
  const normalizedQuery = String(filter.query || "").trim().toLowerCase();
  const viewAndQueryPlans = plans.filter((plan) => {
    if (filter.view && !plan.presentation.views.includes(filter.view)) return false;
    return !normalizedQuery || searchableKnowledgeStrings(plan).some((value) => value.includes(normalizedQuery));
  });
  const includeFacets = filter.includeFacets !== false;
  const statusFacets = new Map<string, RolePlanPage<T>["facets"]["statuses"][number]>();
  const tagFacets = new Map<string, RolePlanPage<T>["facets"]["tags"][number]>();
  if (includeFacets) {
    for (const plan of viewAndQueryPlans) {
      const status = plan.presentation.status;
      const current = statusFacets.get(status);
      if (current) current.count += 1;
      else statusFacets.set(status, { status, count: 1, palette: plan.presentation.palette });
    }
    for (const plan of viewAndQueryPlans) {
      const planTags = new Set<string>();
      for (const rawTag of plan.keywords || []) {
        const tag = String(rawTag || "").trim();
        const normalizedTag = tag.toLocaleLowerCase();
        if (!tag || planTags.has(normalizedTag)) continue;
        planTags.add(normalizedTag);
        const current = tagFacets.get(normalizedTag);
        if (current) current.count += 1;
        else tagFacets.set(normalizedTag, { tag, count: 1 });
      }
    }
  }
  const selectedStatuses = filter.statuses?.length ? new Set(filter.statuses) : undefined;
  const statusFilteredPlans = selectedStatuses
    ? viewAndQueryPlans.filter((plan) => selectedStatuses.has(plan.presentation.status))
    : viewAndQueryPlans;
  const selectedTags = filter.tags?.length
    ? new Set(filter.tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))
    : undefined;
  const filteredPlans = selectedTags
    ? statusFilteredPlans.filter((plan) => plan.keywords.some((tag) => selectedTags.has(tag.trim().toLocaleLowerCase())))
    : statusFilteredPlans;
  const orderedPlans = sortPlans(filteredPlans, filter.sort);
  const items = orderedPlans.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const counts: RolePlanPageCounts = {
    total: plans.length,
    current: plans.filter((plan) => plan.presentation.views.includes("current")).length,
    plans: plans.filter((plan) => plan.presentation.views.includes("plans")).length,
    archived: plans.filter((plan) => plan.presentation.views.includes("archived")).length,
    blocked: plans.filter((plan) => plan.presentation.tone === "blocked").length,
    qa: plans.filter((plan) => plan.presentation.tone === "qa").length,
    active: plans.filter((plan) => !["paused", "done", "archived"].includes(plan.presentation.tone)).length,
    stages: {
      executing: plans.filter((plan) => plan.presentation.tone === "running").length,
      qa: plans.filter((plan) => plan.presentation.tone === "qa").length,
      waitingPackage: plans.filter((plan) => plan.presentation.tone === "waiting_package").length,
      approval: plans.filter((plan) => plan.presentation.tone === "blocked").length,
      manualVerification: plans.filter((plan) => plan.presentation.tone === "manual_verification").length,
      paused: plans.filter((plan) => plan.presentation.tone === "paused").length,
      completed: plans.filter((plan) => plan.presentation.tone === "done").length,
      archived: plans.filter((plan) => plan.presentation.tone === "archived").length
    }
  };
  return {
    items,
    total: orderedPlans.length,
    nextCursor: nextOffset < orderedPlans.length ? String(nextOffset) : "",
    counts,
    facets: {
      statuses: [...statusFacets.values()],
      tags: [...tagFacets.values()].sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "zh-CN"))
    }
  };
}

export function paginateRoleMemory<T>(
  items: T[],
  cursor: string,
  limit: number,
  query: string,
  counts: RoleMemoryPageCounts
): RoleMemoryPage<T> {
  const offset = cursorOffset(cursor);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter((item) => searchableKnowledgeStrings(item).some((value) => value.includes(normalizedQuery)))
    : items;
  const pageItems = filteredItems.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    total: filteredItems.length,
    nextCursor: nextOffset < filteredItems.length ? String(nextOffset) : "",
    counts
  };
}

function searchableKnowledgeStrings(value: unknown, output: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    output.push(value.toLowerCase());
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) searchableKnowledgeStrings(item, output, seen);
    return output;
  }
  for (const item of Object.values(value as Record<string, unknown>)) searchableKnowledgeStrings(item, output, seen);
  return output;
}

function currentPlanStep(plan: RolePlanSummarySource) {
  return plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.steps.find((step) => step.status === "进行中");
}

function planStepSummary(plan: RolePlanSummarySource) {
  const step = currentPlanStep(plan);
  if (!step) return undefined;
  return {
    id: step.id,
    title: step.title,
    status: step.status
  };
}

function planStepPreview(plan: RolePlanSummarySource) {
  const step = currentPlanStep(plan);
  if (!step) return undefined;
  const { approvalRequest: _approvalRequest, ...preview } = step;
  return preview;
}

function planProgressSummary(plan: RolePlanSummarySource) {
  const currentStepId = currentPlanStep(plan)?.id;
  const currentIndex = plan.steps.findIndex((step) => step.id === currentStepId);
  return {
    attachmentCount: plan.attachments.length,
    stepCount: plan.steps.length,
    completedStepCount: plan.steps.filter((step) => step.status === "已完成").length,
    currentStepPosition: currentIndex >= 0 ? currentIndex + 1 : 0
  };
}

function planPresentationWithoutContract(plan: RolePlanSummarySource) {
  const { contract: _contract, ...approval } = plan.presentation.approval as RolePlanSummarySource["presentation"]["approval"] & { contract?: unknown };
  return {
    ...plan.presentation,
    approval
  };
}

export function summarizeRolePlan(plan: RolePlanSummarySource) {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    importance: plan.importance,
    urgency: plan.urgency,
    priority: plan.priority,
    kind: plan.kind,
    currentStep: plan.currentStep,
    currentStepId: plan.currentStepId,
    currentStepPreview: planStepSummary(plan),
    dueAt: plan.dueAt,
    project: plan.project ? { name: plan.project.name } : undefined,
    secretaryBinding: plan.secretaryBinding,
    taskBinding: plan.taskBinding,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    keywords: plan.keywords,
    ...planProgressSummary(plan),
    detailLevel: "summary" as const,
    presentation: planPresentationWithoutContract(plan)
  };
}

export function previewRolePlan(plan: RolePlanSummarySource) {
  return {
    ...plan,
    steps: [],
    currentStepPreview: planStepPreview(plan),
    ...planProgressSummary(plan),
    detailLevel: "preview" as const,
    presentation: planPresentationWithoutContract(plan)
  };
}
import type { PresentedPlanItem } from "./roleKnowledgePresentation.js";
