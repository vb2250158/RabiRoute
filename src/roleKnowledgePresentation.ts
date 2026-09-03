import type {
  ConsolidatedMemoryItem,
  PlanApprovalRequest,
  PlanItem,
  RecentMemoryItem
} from "./roleKnowledge.js";
import type { PlanAttachmentPresentation } from "./shared/planAttachmentContract.js";
import { planApprovalGate } from "./roleKnowledge.js";
import {
  personaPlanWorkflowRevision,
  planStatusDefinition,
  type PersonaPlanStatusDefinition,
  type PersonaPlanWorkflow
} from "./personaPlanWorkflow.js";
import {
  PLAN_IMPORTANCE_PRESENTATION,
  PLAN_URGENCY_PRESENTATION,
  PlanImportanceLevel,
  PlanUrgencyLevel,
  resolvePlanImportanceLevel,
  resolvePlanUrgencyLevel
} from "./shared/planSortContract.js";

export type PlanPresentationTone = string;
export type PlanPresentationView = "current" | "plans" | "archived";

export type PlanPresentationPalette = {
  accent: string;
  background: string;
  foreground: string;
};

export type PlanPresentation = {
  status: string;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  tone: PlanPresentationTone;
  statusLevel: number;
  sortBucket: number;
  views: PlanPresentationView[];
  palette: PlanPresentationPalette;
  acceptsGuidance: boolean;
  terminal: boolean;
  archiveEligible: boolean;
  currentStep: "required" | "optional" | "forbidden";
  roles: string[];
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

function definitionFor(plan: PlanItem, workflow: PersonaPlanWorkflow): PersonaPlanStatusDefinition {
  const definition = planStatusDefinition(workflow, plan.status, { allowRetired: true });
  if (!definition) throw new Error(`PLAN_STATUS_CONFIG_INVALID: ${plan.status} is not defined by this persona.`);
  return definition;
}

export function planPresentation(
  plan: PlanItem,
  workflow: PersonaPlanWorkflow
): PlanPresentation {
  const approval = approvalPresentation(plan);
  const definition = definitionFor(plan, workflow);
  const views: PlanPresentationView[] = plan.archiveStatus === "已归档"
    ? ["archived"]
    : [...definition.views];
  return buildPlanPresentation(
    plan,
    definition,
    workflow,
    views,
    approval
  );
}

function buildPlanPresentation(
  plan: PlanItem,
  definition: PersonaPlanStatusDefinition,
  workflow: PersonaPlanWorkflow,
  views: PlanPresentationView[],
  approval: PlanPresentation["approval"]
): PlanPresentation {
  const statusLevel = definition.order;
  const importanceLevel = resolvePlanImportanceLevel(plan.importance ?? plan.priority);
  const urgencyLevel = resolvePlanUrgencyLevel(plan.urgency, plan.dueAt);
  const importance = PLAN_IMPORTANCE_PRESENTATION[importanceLevel];
  const urgency = PLAN_URGENCY_PRESENTATION[urgencyLevel];
  return {
    status: definition.key,
    label: definition.label,
    labelEn: definition.labelEn,
    description: definition.description,
    descriptionEn: definition.descriptionEn,
    tone: definition.key,
    statusLevel,
    sortBucket: statusLevel,
    views: [...views],
    palette: { ...definition.palette },
    acceptsGuidance: definition.acceptsGuidance,
    terminal: definition.terminal,
    archiveEligible: definition.archiveEligible,
    currentStep: definition.currentStep,
    roles: Object.entries(workflow.roles)
      .filter(([, key]) => key === definition.key)
      .map(([role]) => role),
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

export function presentPlan(
  plan: PlanItem,
  workflow: PersonaPlanWorkflow
): PresentedPlanItem {
  return {
    ...plan,
    attachments: plan.attachments.map(({ path: _path, ...attachment }) => attachment),
    presentation: planPresentation(plan, workflow)
  };
}

const presentedPlanCatalogCache = new WeakMap<PlanItem[], Map<string, PresentedPlanItem[]>>();

export function presentPlans(
  plans: PlanItem[],
  workflow: PersonaPlanWorkflow
): PresentedPlanItem[] {
  const revision = personaPlanWorkflowRevision(workflow);
  const byRevision = presentedPlanCatalogCache.get(plans);
  const cached = byRevision?.get(revision);
  if (cached) return cached;
  const presented = plans
    .map(plan => presentPlan(plan, workflow))
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
  const nextByRevision = byRevision ?? new Map<string, PresentedPlanItem[]>();
  nextByRevision.set(revision, presented);
  presentedPlanCatalogCache.set(plans, nextByRevision);
  return presented;
}

export function sortKnowledgeByUpdatedAt<T extends DatedKnowledgeItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const dateDelta = dateValue(right.updatedAt, right.createdAt) - dateValue(left.updatedAt, left.createdAt);
    return dateDelta || left.id.localeCompare(right.id);
  });
}
