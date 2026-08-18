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
import {
  planHasPackageLifecycle,
  planIsWaitingForPackage,
  planIsWaitingForQaAcceptance
} from "./planPackageWaiting.js";
import {
  PLAN_IMPORTANCE_PRESENTATION,
  PLAN_URGENCY_PRESENTATION,
  PlanImportanceLevel,
  PlanStatusSortLevel,
  PlanUrgencyLevel,
  resolvePlanImportanceLevel,
  resolvePlanUrgencyLevel
} from "./shared/planSortContract.js";

export type PlanPresentationTone = "blocked" | "manual_verification" | "qa" | "running" | "waiting_package" | "done" | "archived" | "paused" | "unknown";
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
  manual_verification: PlanStatusSortLevel.Qa,
  qa: PlanStatusSortLevel.Qa,
  running: PlanStatusSortLevel.Running,
  waiting_package: PlanStatusSortLevel.WaitingPackage,
  done: PlanStatusSortLevel.Done,
  archived: PlanStatusSortLevel.Archived,
  unknown: PlanStatusSortLevel.Unknown,
  paused: PlanStatusSortLevel.Paused
};

const PLAN_PRESENTATION_PALETTE: Record<PlanPresentationTone, PlanPresentationPalette> = {
  blocked: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
  manual_verification: { accent: "#f97316", background: "#fff7ed", foreground: "#c2410c" },
  qa: { accent: "#7c3aed", background: "#f3e8ff", foreground: "#6d28d9" },
  running: { accent: "#16a34a", background: "#eaf8ef", foreground: "#15803d" },
  waiting_package: { accent: "#2563eb", background: "#eff6ff", foreground: "#1d4ed8" },
  done: { accent: "#607d8b", background: "#eaf4f7", foreground: "#52677a" },
  archived: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" },
  paused: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" },
  unknown: { accent: "#8795a1", background: "#eef1f4", foreground: "#687786" }
};

function planActionText(plan: PlanItem): string {
  const step = currentPlanStep(plan);
  return [plan.currentStep, plan.nextAction, step?.title, step?.detail]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function hasExecutableAlternative(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  const action = [plan.nextAction, step?.title]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
  return action
    .split(/[\n。；;，,]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/(?:已发送|已送达|已完成|已执行|已运行|已闭合|禁止重发|禁止重复发送|只等待|仅等待)/i.test(sentence))
    .some((sentence) => /(?:^|[，,:：])\s*(?:先|仍可|继续|改用|替代|重试|可执行|运行|执行|发送|修复|补跑|补发)[^\n]{0,100}(?:CLI|命令行|node\s|npm(?:\.cmd)?\s|脚本|静态检查|只读检查|替代验证|重试路径|发送|QA|验收请求|修复锚点|cli|command|script|static check|fallback|retry)/i.test(sentence));
}

function isWaitingForRenewedAuthorization(plan: PlanItem): boolean {
  const waiting = [authoritativeWaitingText(plan), planActionText(plan)]
    .filter(Boolean)
    .join("\n");
  return /(?:用户|负责人|审批人)[^\n]{0,40}(?:明确)?(?:禁止|不允许|未授权|撤销授权)[^\n]{0,80}(?:Unity|GUI|MCP|菜单|PlayMode|Editor)|(?:等待|需)[^\n]{0,40}(?:重新授权|恢复授权|明确授权)/i.test(waiting);
}

function authoritativeWaitingText(plan: PlanItem): string {
  const step = currentPlanStep(plan);
  return [step?.waitingFor, plan.waitingFor]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function planIsWaitingForManualVerification(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  const currentStepId = String(plan.currentStepId || "").trim();
  const manualStep = /^manual-verify-/i.test(currentStepId);
  if (!manualStep) return false;
  const currentIndex = step ? plan.steps.findIndex((item) => item.id === step.id) : -1;
  return currentIndex > 0 && plan.steps.slice(0, currentIndex).every((item) => item.status === "已完成");
}

function isPangHuSharedUnityContention(plan: PlanItem): boolean {
  const waiting = authoritativeWaitingText(plan);
  if (!waiting) return false;
  return /(?:Main\s*Unity|Main\s*Editor|正式\s*Main)[^\n]{0,100}(?:owner|占用|忙碌|队列|排队|导入|Importing|MCP|工作位|退出|释放|空闲)|(?:共享|唯一)[^\n]{0,60}(?:Unity|PlayMode|EditMode|测试|runner|工作位)/i.test(waiting);
}

function hasUnactionableWait(plan: PlanItem): boolean {
  const waiting = authoritativeWaitingText(plan);
  return Boolean(waiting)
    && !isPangHuSharedUnityContention(plan)
    && (isWaitingForRenewedAuthorization(plan) || !hasExecutableAlternative(plan));
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
  const build = (status: string, tone: PlanPresentationTone) => buildPlanPresentation(plan, status, tone, views, approval);
  if (plan.status === "进行中") {
    if (planIsBlocked(plan)) {
      return build("待审批", "blocked");
    }
    if (isWaitingForRenewedAuthorization(plan)) return build("暂停", "paused");
    if (isPangHuSharedUnityContention(plan)) return build("进行中", "running");
    if (planIsWaitingForManualVerification(plan)) return build("待人工核验", "manual_verification");
    if (planIsWaitingForPackage(plan)) return build("等待打包", "waiting_package");
    if (planIsWaitingForQaAcceptance(plan) && (planHasPackageLifecycle(plan) || !hasExecutableAlternative(plan))) {
      return build("等待 QA", "qa");
    }
    if (approval.state !== "incomplete" && hasUnactionableWait(plan)) return build("暂停", "paused");
    return build("进行中", "running");
  }
  if (plan.status === "未开始") return build("暂停", "paused");
  if (plan.status === "暂停") return build(plan.status, "paused");
  if (plan.status === "已完成") return build(plan.status, "done");
  if (plan.status === "已归档") return build(plan.status, "archived");
  return build(plan.status, "unknown");
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
      const pausedDelta = Number(left.presentation.tone === "paused") - Number(right.presentation.tone === "paused");
      if (pausedDelta !== 0) return pausedDelta;
      const approvalRank = { ready: 0, incomplete: 1, none: 2 } as const;
      const approvalDelta = approvalRank[left.presentation.approval.state] - approvalRank[right.presentation.approval.state];
      if (approvalDelta !== 0) return approvalDelta;
      const statusDelta = left.presentation.statusLevel - right.presentation.statusLevel;
      if (statusDelta !== 0) return statusDelta;
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
