import type { PlanApprovalRequest } from "../roleKnowledge.js";
import { approvalDecisionQuestions, normalizePlanQuestions, planQuestionReply,
  type PlanQuestion, type PlanQuestionAnswer } from "./planQuestions.js";

export type PlanFeedbackFormData = {
  questions: PlanQuestion[];
  approvalContract?: PlanApprovalRequest;
  answers: Record<string, PlanQuestionAnswer>;
  text: string;
};

export function normalizePlanFeedbackFormData(value: unknown, currentQuestions: PlanQuestion[], approval: boolean, approvalContract?: PlanApprovalRequest): PlanFeedbackFormData | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Feedback formData must be an object.");
  const raw = value as Record<string, unknown>;
  if (approval && JSON.stringify(raw.approvalContract) !== JSON.stringify(approvalContract)) throw new Error("Feedback approval contract changed; reload before submitting.");
  const questions = normalizePlanQuestions(raw.questions);
  if (JSON.stringify(questions) !== JSON.stringify(normalizePlanQuestions(currentQuestions))) {
    throw new Error("Feedback questions changed; reload the current plan before submitting.");
  }
  if (typeof raw.text !== "string" || raw.text.length > 2000) throw new Error("Feedback formData.text must contain at most 2000 characters.");
  if (!raw.answers || typeof raw.answers !== "object" || Array.isArray(raw.answers)) throw new Error("Feedback formData.answers must be an object.");
  const decisions = approval ? approvalDecisionQuestions(questions) : questions;
  const answers: Record<string, PlanQuestionAnswer> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    if (!decisions.some(question => question.id === id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Feedback contains an unknown or invalid question answer.");
    const answer = value as PlanQuestionAnswer;
    if (Object.keys(answer).some(key => !["optionId", "optionIds", "text"].includes(key))
      || (answer.text !== undefined && (typeof answer.text !== "string" || answer.text.length > 2000))) throw new Error("Feedback contains an invalid question answer.");
    answers[id] = { ...answer };
  }
  if (!planQuestionReply(decisions, answers).valid) throw new Error("Feedback question answers are incomplete or invalid.");
  return { questions, answers, text: raw.text, ...(approval ? { approvalContract } : {}) };
}

export function planFeedbackFormText(form: PlanFeedbackFormData, approval: boolean): string {
  return [planQuestionReply(approval ? approvalDecisionQuestions(form.questions) : form.questions, form.answers).text,
    form.text.trim()].filter(Boolean).join("\n\n");
}
