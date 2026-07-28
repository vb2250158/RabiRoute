import type {
  ConsolidatedMemoryItem,
  PlanApprovalRequest,
  PlanItem,
  RecentMemoryItem
} from "./roleKnowledge.js";
import type { PlanAttachmentPresentation } from "./shared/planAttachmentContract.js";
import {
  approvalRequestMissingFields,
  currentPlanStep,
  planIsBlocked,
  planRequiresApproval
} from "./roleKnowledge.js";

export type PlanPresentationTone = "blocked" | "qa" | "running" | "pending" | "done" | "archived" | "paused" | "unknown";
export type PlanPresentationView = "current" | "plans" | "archived";

export type PlanPresentationPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export type PlanPresentation = {
  status: string;
  tone: PlanPresentationTone;
  views: PlanPresentationView[];
  palette: PlanPresentationPalette;
  approval: {
    state: "none" | "incomplete" | "ready";
    enabled: boolean;
    label: string;
    helper: string;
    stepId?: string;
    missing: string[];
    contract?: PlanApprovalRequest;
  };
};

export type PresentedPlanItem = Omit<PlanItem, "attachments"> & {
  attachments: PlanAttachmentPresentation[];
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
  unknown: 6,
  paused: 7
};

const PLAN_PRESENTATION_PALETTE: Record<PlanPresentationTone, PlanPresentationPalette> = {
  blocked: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
  qa: { accent: "#8e63c7", background: "#f3e8ff", foreground: "#7e22ce" },
  running: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" },
  pending: { accent: "#f59e0b", background: "#fff7e6", foreground: "#a96008" },
  done: { accent: "#607d8b", background: "#eaf4f7", foreground: "#52677a" },
  archived: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" },
  paused: { accent: "#64748b", background: "#f1f5f9", foreground: "#475569" },
  unknown: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
};

function blocker(plan: PlanItem): string {
  return currentPlanStep(plan)?.blockedBy?.trim() || plan.blockedBy?.trim() || "";
}

function isWaitingForQa(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  if (!step || step.status !== "进行中") return false;
  const structuredStepId = step.id.trim().toLowerCase();
  return /^(qa|verify)(?:[-_:].*)?$/.test(structuredStepId);
}

function approvalPresentation(plan: PlanItem): PlanPresentation["approval"] {
  const step = currentPlanStep(plan);
  const requiresApproval = planRequiresApproval(plan);
  if (!requiresApproval) {
    return {
      state: "none",
      enabled: false,
      label: "无需审批",
      helper: "当前步骤没有声明人工审批门禁。",
      missing: []
    };
  }
  const contract = step?.approvalRequest;
  const missing = approvalRequestMissingFields(contract);
  const ready = missing.length === 0;
  return {
    state: ready ? "ready" : "incomplete",
    enabled: ready,
    label: ready ? "审批执行合同" : "审批资料不完整 / 禁止审批",
    helper: ready
      ? "请先核对审批人、具体决定、推荐与备选、文件、命令、外部变更、验证、回退、排除范围、附件和回执状态，再决定是否批准。"
      : "当前审批资料缺少必要栏目，计划继续保持阻塞；补齐前禁止提交审批决定。",
    stepId: step?.id,
    missing,
    contract
  };
}

function dateValue(primary: string | undefined, fallback: string | undefined): number {
  const value = Date.parse(primary || fallback || "");
  return Number.isFinite(value) ? value : 0;
}

export function planPresentation(plan: PlanItem): PlanPresentation {
  const approval = approvalPresentation(plan);
  const views: PlanPresentationView[] = plan.status === "已归档"
    ? ["archived"]
    : plan.status === "进行中"
      ? ["current", "plans"]
      : ["plans"];
  if (plan.status === "进行中") {
    if (planIsBlocked(plan) && blocker(plan)) {
      return buildPlanPresentation("阻塞中", "blocked", views, approval);
    }
    if (isWaitingForQa(plan)) return buildPlanPresentation("待QA测试", "qa", views, approval);
    return buildPlanPresentation("进行中", "running", views, approval);
  }
  if (plan.status === "未开始") return buildPlanPresentation(plan.status, "pending", views, approval);
  if (plan.status === "暂停") return buildPlanPresentation(plan.status, "paused", views, approval);
  if (plan.status === "已完成") return buildPlanPresentation(plan.status, "done", views, approval);
  if (plan.status === "已归档") return buildPlanPresentation(plan.status, "archived", views, approval);
  return buildPlanPresentation(plan.status, "unknown", views, approval);
}

function buildPlanPresentation(
  status: string,
  tone: PlanPresentationTone,
  views: PlanPresentationView[],
  approval: PlanPresentation["approval"]
): PlanPresentation {
  return {
    status,
    tone,
    views: [...views],
    palette: { ...PLAN_PRESENTATION_PALETTE[tone] },
    approval
  };
}

export function presentPlan(plan: PlanItem): PresentedPlanItem {
  return {
    ...plan,
    attachments: plan.attachments.map(({ path: _path, ...attachment }) => attachment),
    presentation: planPresentation(plan)
  };
}

export function presentPlans(plans: PlanItem[]): PresentedPlanItem[] {
  return plans
    .map(presentPlan)
    .sort((left, right) => {
      const pausedDelta = Number(left.presentation.tone === "paused") - Number(right.presentation.tone === "paused");
      if (pausedDelta !== 0) return pausedDelta;
      const approvalRank = { ready: 0, incomplete: 1, none: 2 } as const;
      const approvalDelta = approvalRank[left.presentation.approval.state] - approvalRank[right.presentation.approval.state];
      if (approvalDelta !== 0) return approvalDelta;
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
