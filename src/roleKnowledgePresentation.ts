import type {
  ConsolidatedMemoryItem,
  PlanItem,
  PlanStep,
  RecentMemoryItem
} from "./roleKnowledge.js";

export type PlanPresentationTone = "blocked" | "qa" | "running" | "pending" | "done" | "archived" | "unknown";

export type PlanPresentation = {
  status: string;
  tone: PlanPresentationTone;
  approval: {
    enabled: boolean;
    label: string;
    helper: string;
    stepId?: string;
  };
};

export type PresentedPlanItem = PlanItem & {
  presentation: PlanPresentation;
};

type DatedKnowledgeItem = Pick<RecentMemoryItem | ConsolidatedMemoryItem, "id" | "createdAt" | "updatedAt">;

const PLAN_STATUS_RANK: Record<PlanPresentationTone, number> = {
  blocked: 0,
  qa: 1,
  running: 2,
  pending: 3,
  done: 4,
  archived: 5,
  unknown: 6
};

function currentStep(plan: PlanItem): PlanStep | undefined {
  if (plan.currentStepId) {
    const explicit = plan.steps.find((step) => step.id === plan.currentStepId);
    if (explicit) return explicit;
  }
  return plan.steps.find((step) => step.status === "进行中");
}

function blocker(plan: PlanItem): string {
  return currentStep(plan)?.blockedBy?.trim() || plan.blockedBy?.trim() || "";
}

function isWaitingForQa(plan: PlanItem): boolean {
  const step = currentStep(plan);
  const signals = [
    plan.currentStep,
    plan.waitingFor,
    step?.title,
    step?.detail,
    step?.waitingFor
  ];
  return signals.some((signal) => {
    const normalized = String(signal || "").toLowerCase().replace(/\s+/g, "");
    if (!normalized) return false;
    if (normalized.includes("qa") && ["待", "测试", "验收"].some((token) => normalized.includes(token))) return true;
    return ["待验收", "等待验收", "待测试", "等待测试"].some((token) => normalized.includes(token));
  });
}

function approvalPresentation(plan: PlanItem): PlanPresentation["approval"] {
  const step = currentStep(plan);
  const signals = [
    plan.kind,
    plan.currentStep,
    plan.waitingFor,
    plan.blockedBy,
    step?.title,
    step?.detail,
    step?.waitingFor,
    step?.blockedBy
  ];
  const requiresApproval = plan.status !== "已完成"
    && plan.status !== "已归档"
    && signals.some((signal) => /human-gate|审批|审核|确认|决策|验收|qa|人工|接管/i.test(String(signal || "")));
  return {
    enabled: requiresApproval,
    label: "审批建议",
    helper: "意见会由 Rabi Manager 记录并交给 Agent；提交本身不会直接推进计划。",
    stepId: requiresApproval ? step?.id : undefined
  };
}

function dateValue(primary: string | undefined, fallback: string | undefined): number {
  const value = Date.parse(primary || fallback || "");
  return Number.isFinite(value) ? value : 0;
}

export function planPresentation(plan: PlanItem): PlanPresentation {
  const approval = approvalPresentation(plan);
  if (plan.status === "进行中") {
    if (blocker(plan)) return { status: "阻塞中", tone: "blocked", approval };
    if (isWaitingForQa(plan)) return { status: "待QA测试", tone: "qa", approval };
    return { status: "进行中", tone: "running", approval };
  }
  if (plan.status === "未开始") return { status: plan.status, tone: "pending", approval };
  if (plan.status === "已完成") return { status: plan.status, tone: "done", approval };
  if (plan.status === "已归档") return { status: plan.status, tone: "archived", approval };
  return { status: plan.status, tone: "unknown", approval };
}

export function presentPlan(plan: PlanItem): PresentedPlanItem {
  return { ...plan, presentation: planPresentation(plan) };
}

export function presentPlans(plans: PlanItem[]): PresentedPlanItem[] {
  return plans
    .map(presentPlan)
    .sort((left, right) => {
      const statusDelta = PLAN_STATUS_RANK[left.presentation.tone] - PLAN_STATUS_RANK[right.presentation.tone];
      if (statusDelta !== 0) return statusDelta;
      const dateDelta = dateValue(right.updatedAt, right.createdAt) - dateValue(left.updatedAt, left.createdAt);
      if (dateDelta !== 0) return dateDelta;
      return left.id.localeCompare(right.id);
    });
}

export function sortKnowledgeByUpdatedAt<T extends DatedKnowledgeItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const dateDelta = dateValue(right.updatedAt, right.createdAt) - dateValue(left.updatedAt, left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}
