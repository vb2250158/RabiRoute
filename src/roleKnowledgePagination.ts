export type RolePlanPageCounts = {
  total: number;
  current: number;
  plans: number;
  archived: number;
  blocked: number;
  qa: number;
  active: number;
};

export type RolePlanPage<T> = {
  items: T[];
  total: number;
  nextCursor: string;
  counts: RolePlanPageCounts;
};

type RolePlanSummarySource = PresentedPlanItem;

export type RolePlanSummary = ReturnType<typeof summarizeRolePlan>;

type PresentedPlanLike = {
  presentation: {
    tone: string;
    views: string[];
  };
};

export const DEFAULT_ROLE_PLAN_PAGE_SIZE = 12;
export const MAX_ROLE_PLAN_PAGE_SIZE = 50;

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

export function paginateRolePlans<T extends PresentedPlanLike>(
  plans: T[],
  cursor: string,
  limit: number
): RolePlanPage<T> {
  const offset = cursorOffset(cursor);
  const items = plans.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const counts: RolePlanPageCounts = {
    total: plans.length,
    current: plans.filter((plan) => plan.presentation.views.includes("current")).length,
    plans: plans.filter((plan) => plan.presentation.views.includes("plans")).length,
    archived: plans.filter((plan) => plan.presentation.views.includes("archived")).length,
    blocked: plans.filter((plan) => plan.presentation.tone === "blocked").length,
    qa: plans.filter((plan) => plan.presentation.tone === "qa").length,
    active: plans.filter((plan) => !["paused", "done", "archived"].includes(plan.presentation.tone)).length
  };
  return {
    items,
    total: plans.length,
    nextCursor: nextOffset < plans.length ? String(nextOffset) : "",
    counts
  };
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
