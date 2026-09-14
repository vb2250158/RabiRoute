import type { PersonaPlanWorkflow } from "./personaPlanWorkflow.js";

/** 生命周期固定；人格工作流只拥有标记。旧字段仅作兼容投影。 */
export const PLAN_ACTIVATION_STATUSES = ["进行中", "已完成", "已归档"] as const;
export type PlanActivationStatus = typeof PLAN_ACTIVATION_STATUSES[number];
type StateInput = {
  activationStatus?: unknown; markerStatus?: unknown; status?: unknown;
  archiveStatus?: unknown; archivedAt?: unknown;
};

export function planMarkerStatus(plan: StateInput): string {
  return String(plan.markerStatus ?? plan.status ?? "").trim();
}

export function planActivationStatus(plan: StateInput, workflow?: PersonaPlanWorkflow): PlanActivationStatus {
  if (plan.activationStatus !== undefined) {
    if (!PLAN_ACTIVATION_STATUSES.includes(plan.activationStatus as PlanActivationStatus)) {
      throw new Error("Unsupported plan activationStatus. Use 进行中, 已完成 or 已归档.");
    }
    return plan.activationStatus as PlanActivationStatus;
  }
  const marker = planMarkerStatus(plan);
  if (plan.archiveStatus === "已归档" || plan.archivedAt || marker === "关闭" || marker === "已归档"
    || (workflow && marker === workflow.roles.closed)) return "已归档";
  if (marker === "完成" || marker === "已完成" || (workflow && marker === workflow.roles.completed)) return "已完成";
  return "进行中";
}

export function planState(plan: StateInput, workflow?: PersonaPlanWorkflow) {
  const activationStatus = planActivationStatus(plan, workflow);
  const markerStatus = planMarkerStatus(plan);
  return { activationStatus, markerStatus, status: markerStatus,
    archiveStatus: activationStatus === "已归档" ? "已归档" as const : "未归档" as const };
}

/** 必须在合并 PATCH 前处理别名，避免旧投影覆盖规范字段。 */
export function planStateForWrite(patch: StateInput, existing: StateInput | undefined, workflow: PersonaPlanWorkflow) {
  if (patch.markerStatus !== undefined && (typeof patch.markerStatus !== "string" || !patch.markerStatus.trim())) {
    throw new Error("Plan markerStatus must be a non-empty configured marker key.");
  }
  if (patch.markerStatus !== undefined && patch.status !== undefined && patch.markerStatus !== patch.status) {
    throw new Error("Conflicting plan markerStatus and legacy status.");
  }
  const markerStatus = planMarkerStatus(patch) || (existing ? planMarkerStatus(existing) : workflow.roles.initial);
  let activationStatus = patch.activationStatus === undefined
    ? existing ? planActivationStatus(existing, workflow) : patch.markerStatus !== undefined ? "进行中" : planActivationStatus(patch, workflow)
    : planActivationStatus(patch);
  // 旧客户端的组合状态写入继续兼容；新客户端只写两个明确命名的字段。
  if (patch.activationStatus === undefined && patch.markerStatus === undefined && patch.status !== undefined) {
    activationStatus = planActivationStatus({ status: patch.status }, workflow);
  }
  if (patch.activationStatus === undefined && patch.archiveStatus === "已归档") activationStatus = "已归档";
  if (patch.activationStatus !== undefined && patch.archiveStatus !== undefined
    && (patch.archiveStatus === "已归档") !== (activationStatus === "已归档")) {
    throw new Error("Conflicting plan activationStatus and legacy archiveStatus.");
  }
  return planState({ activationStatus, markerStatus });
}

export function planCanAutoAdvance(plan: StateInput, workflow: PersonaPlanWorkflow): boolean {
  return planActivationStatus(plan, workflow) === "进行中" && planMarkerStatus(plan) !== workflow.roles.paused;
}
