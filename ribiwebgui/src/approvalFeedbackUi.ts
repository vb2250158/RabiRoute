import { presentError } from "../../src/shared/errorPresentation";
import type { RolePlan, RolePlanApprovalContract, RolePlanFeedback } from "./types";
import type { PlanQuestion } from "../../src/shared/planQuestions";

// Receipt metadata changes after submission; it is not a change to the request.
export function approvalContractSignature(contract?: RolePlanApprovalContract): string {
  if (!contract) return "";
  const { responseStatus: _responseStatus, feedbackId: _feedbackId, ...request } = contract;
  return JSON.stringify(request);
}

export function approvalQuestionSignature(roleId: string, plan: RolePlan, questions: PlanQuestion[]): string {
  return JSON.stringify([roleId, plan.id, plan.presentation.approval.stepId || plan.currentStepId,
    questions, approvalContractSignature(plan.presentation.approval.contract)]);
}

export function matchingApprovalFeedback(plan: RolePlan, questions: PlanQuestion[]): RolePlanFeedback | undefined {
  const records = plan.approval.records?.length ? plan.approval.records : plan.approval.latest ? [plan.approval.latest] : [];
  return [...records].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find(feedback =>
    feedback.kind === "approval_suggestion" && feedback.author === "user"
    && feedback.stepId === (plan.presentation.approval.stepId || plan.currentStepId)
    && Boolean(feedback.formData?.approvalContract)
    && approvalContractSignature(feedback.formData?.approvalContract) === approvalContractSignature(plan.presentation.approval.contract)
    && (!feedback.formData || JSON.stringify(feedback.formData.questions) === JSON.stringify(questions)));
}

export function approvalPanelExpanded(plan: RolePlan, editing: boolean): boolean {
  return plan.presentation.approval.state !== "approved" || editing;
}

export function localizedPlanError(error: unknown, english = false): string {
  const value = error && typeof error === "object" ? error as { message?: string; details?: import("../../src/shared/errorPresentation").ErrorDetails } : {};
  return presentError(value.message ?? String(error || ""), value.details, english ? "en" : "zh-CN");
}
export function planFeedbackSubmissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error || "").trim();
  if (/failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)) {
    return "无法连接 Manager，服务可能正在重启或网络暂时中断。计划反馈内容已保留，请稍后重试。";
  }
  return localizedPlanError(error);
}
export const approvalSubmissionErrorMessage = planFeedbackSubmissionErrorMessage;
