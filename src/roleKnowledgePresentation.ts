import type {
  ConsolidatedMemoryItem,
  PlanApprovalRequest,
  PlanItem,
  RecentMemoryItem
} from "./roleKnowledge.js";
import {
  approvalRequestMissingFields,
  currentPlanStep,
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
    enabled: true,
    label: ready ? "审批执行合同" : "审批信息待补充",
    helper: ready
      ? "请先核对具体文件、命令、变更、验证和回退范围，再决定是否批准。"
      : "当前执行说明还不够具体；仍可提交审批意见，Manager 会提醒 Agent 根据意见补齐文件、命令和变更范围。",
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
    if (blocker(plan) && approval.state !== "none") {
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
  return { ...plan, presentation: planPresentation(plan) };
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
