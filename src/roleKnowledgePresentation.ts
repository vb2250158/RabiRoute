import type {
  ConsolidatedMemoryItem,
  PlanApprovalRequest,
  PlanItem,
  RecentMemoryItem
} from "./roleKnowledge.js";
import type { PlanAttachmentPresentation } from "./shared/planAttachmentContract.js";
import { planApprovalGate } from "./roleKnowledge.js";
import {
  PLAN_IMPORTANCE_PRESENTATION,
  PLAN_URGENCY_PRESENTATION,
  PlanImportanceLevel,
  PlanStatusSortLevel,
  PlanUrgencyLevel,
  resolvePlanImportanceLevel,
  resolvePlanUrgencyLevel
} from "./shared/planSortContract.js";

export type PlanPresentationTone = "blocked" | "discussion" | "qa" | "analyzing" | "executing" | "waiting_package" | "done" | "closed" | "paused" | "unknown";
export type PlanPresentationView = "current" | "plans" | "archived";

export type PlanPresentationPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export type PlanPresentation = {
  status: string;
  tone: PlanPresentationTone;
  statusLevel: PlanStatusSortLevel;
  sortBucket: number;
  views: PlanPresentationView[];
  palette: PlanPresentationPalette;
  importance: {
    level: PlanImportanceLevel;
    label: string;
    labelEn: string;
    palette: PlanPresentationPalette;
  };
  urgency: {
    level: PlanUrgencyLevel;
    label: string;
    labelEn: string;
    palette: PlanPresentationPalette;
  };
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

const PLAN_STATUS_RANK: Record<PlanPresentationTone, PlanStatusSortLevel> = {
  blocked: PlanStatusSortLevel.Approval,
  discussion: PlanStatusSortLevel.Discussion,
  qa: PlanStatusSortLevel.Qa,
  analyzing: PlanStatusSortLevel.Analyzing,
  executing: PlanStatusSortLevel.Executing,
  waiting_package: PlanStatusSortLevel.WaitingPackage,
  done: PlanStatusSortLevel.Done,
  closed: PlanStatusSortLevel.Closed,
  paused: PlanStatusSortLevel.Paused,
  unknown: PlanStatusSortLevel.Unknown
};

const PLAN_PRESENTATION_PALETTE: Record<PlanPresentationTone, PlanPresentationPalette> = {
  blocked: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
  discussion: { accent: "#d97706", background: "#fffbeb", foreground: "#92400e" },
  qa: { accent: "#7c3aed", background: "#f3e8ff", foreground: "#6d28d9" },
  analyzing: { accent: "#0891b2", background: "#ecfeff", foreground: "#0e7490" },
  executing: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" },
  waiting_package: { accent: "#2563eb", background: "#eff6ff", foreground: "#1d4ed8" },
  done: { accent: "#607d8b", background: "#eaf4f7", foreground: "#52677a" },
  closed: { accent: "#475569", background: "#f1f5f9", foreground: "#334155" },
  paused: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" },
  unknown: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
};

function approvalPresentation(plan: PlanItem): PlanPresentation["approval"] {
  const gate = planApprovalGate(plan);
  if (gate.state === "none") {
    return {
      state: "none",
      enabled: false,
      label: "无需审批",
      helper: "当前步骤没有声明人工审批门禁。",
      missing: []
    };
  }
  const ready = gate.state === "pending";
  return {
    state: ready ? "ready" : "incomplete",
    enabled: ready,
    label: ready ? "审批执行合同" : "审批资料不完整 / 禁止审批",
    helper: ready
      ? "请先核对审批人、具体决定、推荐与备选、文件、命令、外部变更、验证、回退、排除范围、附件和回执状态，再决定是否批准。"
      : "当前审批资料缺少必要栏目，计划保持分析中并由 Agent 继续调查、补证据和补齐合同；补齐前不能提交审批决定。",
    stepId: gate.stepId,
    missing: gate.missing,
    contract: gate.contract
  };
}

function dateValue(primary: string | undefined, fallback: string | undefined): number {
  const value = Date.parse(primary || fallback || "");
  return Number.isFinite(value) ? value : 0;
}

function planStatusTone(plan: PlanItem): PlanPresentationTone {
  if (plan.status === "分析中") return "analyzing";
  if (plan.status === "待审批") return "blocked";
  if (plan.status === "执行中") return "executing";
  if (plan.status === "等待打包") return "waiting_package";
  if (plan.status === "等待 QA") return "qa";
  if (plan.status === "待讨论") return "discussion";
  if (plan.status === "暂停") return "paused";
  if (plan.status === "完成") return "done";
  if (plan.status === "关闭") return "closed";
  return "unknown";
}

export function planPresentation(plan: PlanItem): PlanPresentation {
  const approval = approvalPresentation(plan);
  const views: PlanPresentationView[] = plan.archiveStatus === "已归档"
    ? ["archived"]
    : ["分析中", "待审批", "执行中", "等待打包", "等待 QA"].includes(plan.status)
      ? ["current", "plans"]
      : ["plans"];
  return buildPlanPresentation(
    plan,
    plan.status,
    planStatusTone(plan),
    views,
    approval
  );
}

function buildPlanPresentation(
  plan: PlanItem,
  status: string,
  tone: PlanPresentationTone,
  views: PlanPresentationView[],
  approval: PlanPresentation["approval"]
): PlanPresentation {
  const statusLevel = PLAN_STATUS_RANK[tone];
  const importanceLevel = resolvePlanImportanceLevel(plan.importance ?? plan.priority);
  const urgencyLevel = resolvePlanUrgencyLevel(plan.urgency, plan.dueAt);
  const importance = PLAN_IMPORTANCE_PRESENTATION[importanceLevel];
  const urgency = PLAN_URGENCY_PRESENTATION[urgencyLevel];
  return {
    status,
    tone,
    statusLevel,
    sortBucket: statusLevel,
    views: [...views],
    palette: { ...PLAN_PRESENTATION_PALETTE[tone] },
    importance: {
      level: importanceLevel,
      label: importance.labelZh,
      labelEn: importance.labelEn,
      palette: { ...importance.palette }
    },
    urgency: {
      level: urgencyLevel,
      label: urgency.labelZh,
      labelEn: urgency.labelEn,
      palette: { ...urgency.palette }
    },
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

const presentedPlanCatalogCache = new WeakMap<PlanItem[], PresentedPlanItem[]>();

export function presentPlans(plans: PlanItem[]): PresentedPlanItem[] {
  const cached = presentedPlanCatalogCache.get(plans);
  if (cached) return cached;
  const presented = plans
    .map(presentPlan)
    .sort((left, right) => {
      const statusDelta = left.presentation.statusLevel - right.presentation.statusLevel;
      if (statusDelta !== 0) return statusDelta;
      const approvalRank = { ready: 0, incomplete: 1, none: 2 } as const;
      const approvalDelta = approvalRank[left.presentation.approval.state] - approvalRank[right.presentation.approval.state];
      if (approvalDelta !== 0) return approvalDelta;
      const dateDelta = dateValue(right.updatedAt, right.createdAt) - dateValue(left.updatedAt, left.createdAt);
      if (dateDelta !== 0) return dateDelta;
      return left.id.localeCompare(right.id);
    });
  presentedPlanCatalogCache.set(plans, presented);
  return presented;
}

export function sortKnowledgeByUpdatedAt<T extends DatedKnowledgeItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const dateDelta = dateValue(right.updatedAt, right.createdAt) - dateValue(left.updatedAt, left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}
