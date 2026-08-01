import type {
  ConsolidatedMemoryItem,
  PlanApprovalRequest,
  PlanItem,
  RecentMemoryItem
} from "./roleKnowledge.js";
import type { PlanAttachmentPresentation } from "./shared/planAttachmentContract.js";
import {
  currentPlanStep,
  planApprovalGate,
  planIsBlocked
} from "./roleKnowledge.js";
import { planIsWaitingForPackage } from "./planPackageWaiting.js";

export type PlanPresentationTone = "blocked" | "qa" | "running" | "waiting_external" | "waiting_package" | "pending" | "done" | "archived" | "paused" | "unknown";
export type PlanPresentationView = "current" | "plans" | "archived";

export type PlanPresentationPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export type PlanPresentation = {
  status: string;
  tone: PlanPresentationTone;
  sortBucket: number;
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
  waiting_external: 3,
  waiting_package: 4,
  pending: 5,
  done: 6,
  archived: 7,
  unknown: 8,
  paused: 9
};

const PLAN_PRESENTATION_PALETTE: Record<PlanPresentationTone, PlanPresentationPalette> = {
  blocked: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
  qa: { accent: "#8e63c7", background: "#f3e8ff", foreground: "#7e22ce" },
  running: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" },
  waiting_external: { accent: "#f59e0b", background: "#fff7e6", foreground: "#a96008" },
  waiting_package: { accent: "#2563eb", background: "#eff6ff", foreground: "#1d4ed8" },
  pending: { accent: "#f59e0b", background: "#fff7e6", foreground: "#a96008" },
  done: { accent: "#607d8b", background: "#eaf4f7", foreground: "#52677a" },
  archived: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" },
  paused: { accent: "#64748b", background: "#f1f5f9", foreground: "#475569" },
  unknown: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
};

function isWaitingForQa(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  if (!step || step.status !== "进行中") return false;
  const structuredStepId = step.id.trim().toLowerCase();
  return /^(qa|verify)(?:[-_:].*)?$/.test(structuredStepId);
}

function authoritativeWaitingText(plan: PlanItem): string {
  const step = currentPlanStep(plan);
  return [step?.waitingFor, plan.waitingFor]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function externalWaitingStatus(plan: PlanItem): string {
  const waiting = authoritativeWaitingText(plan);
  if (!waiting) return "";
  if (/(?:环境|测试账号|账号|权限|队列|进程|端口|网络|设备|服务|Unity|Editor|编辑器|MCP|environment|account|permission|queue|process|port|network|device|service)/i.test(waiting)) {
    return "待环境";
  }
  if (/(?:素材|美术|设计稿|图片|音频|视频|PSD|asset|artwork|image|audio|video)/i.test(waiting)) {
    return "待素材";
  }
  return /(?:资料|文档|说明|截图|日志|证据|数据|样本|版本|复现步骤|路径|清单|document|screenshot|log|evidence|data|sample|version|reproduction|path|inventory)/i.test(waiting)
    ? "待资料"
    : /(?:等待|待)[^\n]{0,80}(?:回传|回复|答复|回执|结果|交付|返回|确认)|(?:await|waiting for)[^\n]{0,80}(?:response|reply|receipt|result|delivery|return|confirmation)/i.test(waiting)
      ? "待外部回执"
      : "";
}

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
      : "当前审批资料缺少必要栏目，计划保持进行中并由 Agent 继续调查、补证据和补齐合同；补齐前不会占用阻塞状态，也不能提交审批决定。",
    stepId: gate.stepId,
    missing: gate.missing,
    contract: gate.contract
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
    if (planIsBlocked(plan)) {
      return buildPlanPresentation("待审批", "blocked", views, approval);
    }
    if (isWaitingForQa(plan)) return buildPlanPresentation("等待 QA 验收", "qa", views, approval);
    if (planIsWaitingForPackage(plan)) return buildPlanPresentation("待统一打包", "waiting_package", views, approval);
    const waitingStatus = approval.state === "incomplete" ? "" : externalWaitingStatus(plan);
    if (waitingStatus) return buildPlanPresentation(waitingStatus, "waiting_external", views, approval);
    return buildPlanPresentation("正在执行", "running", views, approval);
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
    sortBucket: PLAN_STATUS_RANK[tone],
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
