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
    waitingExternal: number;
    approval: number;
    pending: number;
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

type PresentedPlanLike = {
  updatedAt: string;
  presentation: {
    status: string;
    tone: string;
    views: string[];
    palette: {
      accent: string;
      background: string;
      foreground: string;
    };
  };
};

export type RolePlanPageFilter = {
  view?: string;
  query?: string;
  sort?: "status" | "updated";
  statuses?: string[];
};

export const DEFAULT_ROLE_PLAN_PAGE_SIZE = 12;
export const MAX_ROLE_PLAN_PAGE_SIZE = 50;
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
  const statusFacets = new Map<string, RolePlanPage<T>["facets"]["statuses"][number]>();
  for (const plan of viewAndQueryPlans) {
    const status = plan.presentation.status;
    const current = statusFacets.get(status);
    if (current) current.count += 1;
    else statusFacets.set(status, { status, count: 1, palette: plan.presentation.palette });
  }
  const selectedStatuses = filter.statuses?.length ? new Set(filter.statuses) : undefined;
  const filteredPlans = selectedStatuses
    ? viewAndQueryPlans.filter((plan) => selectedStatuses.has(plan.presentation.status))
    : viewAndQueryPlans;
  const orderedPlans = filter.sort === "updated"
    ? filteredPlans
      .map((plan, index) => ({ plan, index, updatedAt: new Date(plan.updatedAt).getTime() }))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
        const rightTime = Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
        return rightTime - leftTime || left.index - right.index;
      })
      .map((item) => item.plan)
    : filteredPlans;
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
      waitingExternal: plans.filter((plan) => plan.presentation.tone === "waiting_external").length,
      approval: plans.filter((plan) => plan.presentation.tone === "blocked").length,
      pending: plans.filter((plan) => plan.presentation.tone === "pending").length,
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
    facets: { statuses: [...statusFacets.values()] }
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

export function summarizeRolePlan(plan: RolePlanSummarySource) {
  const { contract: _contract, ...approval } = plan.presentation.approval as RolePlanSummarySource["presentation"]["approval"] & { contract?: unknown };
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    priority: plan.priority,
    kind: plan.kind,
    project: plan.project ? { name: plan.project.name } : undefined,
    secretaryBinding: plan.secretaryBinding,
    taskBinding: plan.taskBinding,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    keywords: plan.keywords,
    attachmentCount: plan.attachments.length,
    stepCount: plan.steps.length,
    presentation: {
      ...plan.presentation,
      approval
    }
  };
}
import type { PresentedPlanItem } from "./roleKnowledgePresentation.js";
