import type { RolePlan } from "./types";

/** Navigation projection only; Manager presentation owns eligibility and status. */
export function pendingFeedbackKind(plan: RolePlan): "approval" | "information" | undefined {
  if (plan.presentation.terminal || plan.presentation.views.includes("archived")) return undefined;
  if (plan.presentation.approval.state === "ready" && plan.presentation.approval.enabled) return "approval";
  if (plan.presentation.roles?.includes("informationNeeded") && plan.presentation.acceptsGuidance && plan.presentation.approval.state === "none") return "information";
  return undefined;
}

/** Filter the navigation cache only, without changing the active record or its draft. */
export function filterFeedbackFocusItems(items: RolePlan[], query: string | null): RolePlan[] {
  const needle = (query ?? "").trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter(plan => [plan.title, plan.focus, plan.currentStep, plan.currentStepPreview?.title,
    plan.currentStepPreview?.detail, plan.nextAction, plan.waitingFor, plan.project?.name, plan.source?.summary]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
}

/** Keep the current selection even when its pending status changes after a submission. */
export function feedbackFocusSelection(current: string, requested: string | undefined, items: RolePlan[]): string {
  return requested || current || items.find(plan => pendingFeedbackKind(plan))?.id || "";
}
