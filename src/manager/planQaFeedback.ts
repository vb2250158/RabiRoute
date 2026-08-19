import {
  listPlanFeedback,
  updatePlanFeedbackQaHandling,
  type PlanFeedbackRecord,
  type PlanQaFeedbackHandling
} from "../planFeedback.js";
import {
  listPlans,
  updatePlan,
  type PlanItem,
  type PlanStep
} from "../roleKnowledge.js";
import type { AgentThreadRequest } from "../agentThreads.js";

export type PlanQaTaskRequest = {
  threadId: string;
  cwd: string;
  prompt: string;
  deliverySource?: NonNullable<AgentThreadRequest["deliverySource"]>;
};

export type ConsumePlanQaFeedbackOptions = {
  roleDir: string;
  feedback: PlanFeedbackRecord;
  sendToTask: (request: PlanQaTaskRequest) => Promise<void>;
};

export type PlanQaFeedbackResult = {
  outcome: "ignored" | "failed" | "passed";
  status: "ignored" | PlanQaFeedbackHandling["status"];
  missingEvidence: string[];
  plan?: PlanItem;
};

const QA_FAILURE_PATTERN = /问题仍存在|仍然存在|未解决|失败复现|仍可复现|依旧存在|没有修复|未通过|验收失败|QA\s+failed|not\s+fixed|still\s+(?:exists|reproducible)|reproduced\s+again/i;
const QA_PASS_PATTERN = /QA\s*明确通过|QA\s*通过|QA\s+(?:passed|verified)|验收通过|问题已解决|确认未再复现|acceptance\s+passed/i;
const QA_STEP_ID = /^(?:qa|verify)(?:[-_:].*)?$/i;

function isQaVerdictFeedback(feedback: PlanFeedbackRecord): boolean {
  return feedback.kind === "approval_suggestion"
    && feedback.author === "user"
    && feedback.source !== "agent";
}

function isQaStep(step: PlanStep | undefined): step is PlanStep {
  return Boolean(step && QA_STEP_ID.test(String(step.id || "")));
}

function qaStepFor(plan: PlanItem, feedback: PlanFeedbackRecord, allowHistorical = false): PlanStep | undefined {
  const requested = feedback.stepId
    ? plan.steps.find((step) => step.id === feedback.stepId)
    : undefined;
  if (isQaStep(requested) && (
    allowHistorical
    || requested.id === plan.currentStepId
    || requested.status === "进行中"
  )) return requested;
  const current = plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.steps.find((step) => step.status === "进行中");
  return isQaStep(current) ? current : undefined;
}

function issueType(feedback: PlanFeedbackRecord, plan: PlanItem): PlanQaFeedbackHandling["issueType"] {
  const text = [
    plan.title,
    plan.focus,
    plan.currentStep,
    feedback.stepTitle,
    feedback.text
  ].filter(Boolean).join(" ");
  if (/账号|玩家|用户|角色|存档|订单|付费/i.test(text)) return "account";
  if (/崩溃|闪退|报错|crash|exception|fatal/i.test(text)) return "crash";
  if (/版本|渠道|包体|客户端|安卓|android|ios|taptap|build/i.test(text)) return "version";
  if (/时间|重置|刷新|结算|延迟|不到账|未到账|定时|北京时间/i.test(text)) return "timing";
  if (/界面|显示|UI|图标|红点|文案|布局|动画|视觉/i.test(text)) return "visual";
  return "generic";
}

function hasReproductionSteps(text: string): boolean {
  return /复现步骤|操作步骤|步骤[:：]|repro(?:duction)?\s+steps?/i.test(text);
}

function hasBeforeAfterState(text: string): boolean {
  const hasBefore = /修复前|操作前|前状态|原状态|之前|before/i.test(text);
  const hasAfter = /修复后|操作后|后状态|当前|实际|现在|after|actual|observed/i.test(text);
  return (hasBefore && hasAfter) || (/预期|期望|expected/i.test(text) && hasAfter);
}

function hasAccountId(text: string): boolean {
  return /(?:账号|玩家|用户|角色)(?:\s*(?:ID|编号|id))\s*[:：#]?\s*[A-Za-z0-9_-]{3,}/i.test(text);
}

function hasBeijingTime(text: string): boolean {
  return /北京时间|20\d{2}[-/年]\d{1,2}|\d{1,2}[:：]\d{2}/i.test(text);
}

function hasVersionChannel(text: string): boolean {
  return /\b\d+\.\d+(?:\.\d+)+\b|(?:版本|渠道|build)\s*[:：#]?\s*[A-Za-z0-9._-]{2,}|TapTap|App\s*Store|Google\s*Play/i.test(text);
}

function hasScreenshotOrVideo(feedback: PlanFeedbackRecord): boolean {
  return feedback.attachments.some((attachment) => attachment.kind === "image"
    || /\.(?:mp4|m4v|webm|mov|avi)$/i.test(attachment.name));
}

function hasLogs(feedback: PlanFeedbackRecord): boolean {
  return feedback.attachments.some((attachment) => /\.(?:log|txt|json|zip|7z)$/i.test(attachment.name));
}

function missingEvidenceFor(
  feedback: PlanFeedbackRecord,
  type: PlanQaFeedbackHandling["issueType"]
): string[] {
  const text = feedback.text;
  if (type === "account") {
    return [
      !hasAccountId(text) ? "账号或玩家编号" : "",
      !hasBeijingTime(text) ? "北京时间" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "version") {
    return [
      !hasVersionChannel(text) ? "版本渠道" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "timing") {
    return [
      !hasBeijingTime(text) ? "北京时间" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasBeforeAfterState(text) ? "前后状态" : ""
    ].filter(Boolean);
  }
  if (type === "visual") {
    return [
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasScreenshotOrVideo(feedback) ? "截图或视频" : ""
    ].filter(Boolean);
  }
  if (type === "crash") {
    return [
      !hasVersionChannel(text) ? "版本渠道" : "",
      !hasReproductionSteps(text) ? "复现步骤" : "",
      !hasLogs(feedback) ? "日志" : ""
    ].filter(Boolean);
  }
  return [
    !hasReproductionSteps(text) ? "复现步骤" : "",
    !hasBeforeAfterState(text) ? "前后状态或实际/预期结果" : ""
  ].filter(Boolean);
}

function investigationStepId(qaStep: PlanStep): string {
  return "investigate-" + qaStep.id;
}

function feedbackDetail(feedback: PlanFeedbackRecord): string {
  const prefix = "QA 失败反馈 " + feedback.id + "：";
  const limit = Math.max(0, 600 - prefix.length);
  const content = feedback.text.length > limit ? feedback.text.slice(0, Math.max(0, limit - 1)) + "…" : feedback.text;
  return prefix + content;
}

function reopenForInvestigation(
  roleDir: string,
  plan: PlanItem,
  qaStep: PlanStep,
  feedback: PlanFeedbackRecord,
  missingEvidence: string[]
): PlanItem {
  const investigateId = investigationStepId(qaStep);
  const existingInvestigation = plan.steps.find((step) => step.id === investigateId);
  const investigation: PlanStep = {
    ...(existingInvestigation || {
      id: investigateId,
      title: "深化调查：" + qaStep.title,
      status: "未开始" as const
    }),
    status: "进行中",
    detail: feedbackDetail(feedback),
    waitingFor: missingEvidence.length ? "QA 补充：" + missingEvidence.join("、") : undefined,
    isBlocked: false,
    blockedBy: undefined
  };
  const steps = plan.steps
    .filter((step) => step.id !== investigateId)
    .map((step) => step.id === qaStep.id
      ? { ...step, status: "未开始" as const, waitingFor: undefined, isBlocked: false, blockedBy: undefined }
      : step);
  const qaIndex = steps.findIndex((step) => step.id === qaStep.id);
  steps.splice(qaIndex < 0 ? steps.length : qaIndex, 0, investigation);
  return updatePlan(roleDir, plan.id, {
    status: "进行中",
    currentStepId: investigateId,
    currentStep: "QA 失败回传已消费，进入深化根因调查",
    nextAction: missingEvidence.length
      ? "取得" + missingEvidence.join("、") + "后继续深化调查并安排复测"
      : "原业务任务根据新证据深化根因分析、修正并重新安排 QA",
    waitingFor: missingEvidence.length ? "QA 补充：" + missingEvidence.join("、") : undefined,
    isBlocked: false,
    blockedBy: undefined,
    completedAt: undefined,
    steps
  });
}

function taskPrompt(plan: PlanItem, feedback: PlanFeedbackRecord): string {
  return [
    "[QA失败回传：继续原业务任务]",
    "计划：" + plan.title,
    "计划 ID：" + plan.id,
    "反馈 ID：" + feedback.id,
    "QA 反馈：" + feedback.text,
    "请基于这份新证据深化根因分析，完成最小修正与针对性验证后重新进入 QA。",
    "必须复用当前计划与原 taskBinding，不得创建重复计划、重复业务任务或替代会话。",
    "只有 QA 明确通过后才可进入验收完成。"
  ].join("\n");
}

function completeAcceptance(
  roleDir: string,
  plan: PlanItem,
  qaStep: PlanStep,
  feedback: PlanFeedbackRecord
): PlanItem {
  const steps = plan.steps.map((step) => step.id === qaStep.id
    ? {
        ...step,
        status: "已完成" as const,
        detail: "QA 明确通过（" + feedback.id + "）：" + feedback.text.slice(0, 500),
        waitingFor: undefined,
        isBlocked: false,
        blockedBy: undefined
      }
    : step);
  const qaIndex = steps.findIndex((step) => step.id === qaStep.id);
  const nextIndex = steps.findIndex((step, index) => index > qaIndex && step.status === "未开始");
  if (nextIndex >= 0) {
    steps[nextIndex] = { ...steps[nextIndex], status: "进行中" };
    return updatePlan(roleDir, plan.id, {
      status: "进行中",
      currentStepId: steps[nextIndex].id,
      currentStep: steps[nextIndex].title,
      nextAction: steps[nextIndex].title,
      waitingFor: undefined,
      isBlocked: false,
      blockedBy: undefined,
      steps
    });
  }
  return updatePlan(roleDir, plan.id, {
    status: "已完成",
    currentStepId: undefined,
    currentStep: "QA 明确通过，验收完成",
    nextAction: undefined,
    waitingFor: undefined,
    isBlocked: false,
    blockedBy: undefined,
    steps
  });
}

export async function consumePlanQaFeedback(
  options: ConsumePlanQaFeedbackOptions
): Promise<PlanQaFeedbackResult> {
  if (!isQaVerdictFeedback(options.feedback)) {
    return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  }
  const feedbackRecords = listPlanFeedback(options.roleDir, options.feedback.planId);
  const latest = feedbackRecords.find((record) => record.id === options.feedback.id) || options.feedback;
  if (latest.qaHandling && latest.qaHandling.status !== "dispatch_failed") {
    return {
      outcome: latest.qaHandling.outcome,
      status: latest.qaHandling.status,
      missingEvidence: latest.qaHandling.missingEvidence,
      plan: listPlans(options.roleDir).find((plan) => plan.id === latest.planId)
    };
  }
  const failed = latest.qaHandling?.status === "dispatch_failed" || QA_FAILURE_PATTERN.test(latest.text);
  const passed = !failed && QA_PASS_PATTERN.test(latest.text);
  const plan = listPlans(options.roleDir).find((item) => item.id === latest.planId);
  if (!plan) throw new Error("Plan not found: " + latest.planId);
  const priorWaiting = [...feedbackRecords].reverse().find((record) => (
    record.id !== latest.id
    && record.qaHandling?.outcome === "failed"
    && record.qaHandling.status === "waiting_for_evidence"
  ));
  const evidenceFollowUp = !failed
    && !passed
    && Boolean(priorWaiting)
    && String(plan.currentStepId || "").startsWith("investigate-");
  if (!failed && !passed && !evidenceFollowUp) {
    return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  }
  const effectiveFeedback: PlanFeedbackRecord = evidenceFollowUp && priorWaiting
    ? {
        ...latest,
        stepId: priorWaiting.stepId,
        stepTitle: priorWaiting.stepTitle,
        text: priorWaiting.text + "\n补充证据：" + latest.text,
        attachments: [...priorWaiting.attachments, ...latest.attachments],
        planAttachments: [...priorWaiting.planAttachments, ...latest.planAttachments]
      }
    : latest;
  const qaStep = qaStepFor(plan, effectiveFeedback, evidenceFollowUp || latest.qaHandling?.status === "dispatch_failed");
  if (!qaStep) return { outcome: "ignored", status: "ignored", missingEvidence: [] };
  if (passed) {
    const updatedPlan = completeAcceptance(options.roleDir, plan, qaStep, latest);
    updatePlanFeedbackQaHandling(options.roleDir, latest, {
      outcome: "passed",
      issueType: "generic",
      status: "completed",
      missingEvidence: [],
      consumedAt: new Date().toISOString()
    });
    return { outcome: "passed", status: "completed", missingEvidence: [], plan: updatedPlan };
  }
  const detectedIssueType = priorWaiting?.qaHandling?.issueType || issueType(effectiveFeedback, plan);
  const missingEvidence = missingEvidenceFor(effectiveFeedback, detectedIssueType);
  const updatedPlan = reopenForInvestigation(options.roleDir, plan, qaStep, effectiveFeedback, missingEvidence);
  if (missingEvidence.length) {
    updatePlanFeedbackQaHandling(options.roleDir, latest, {
      outcome: "failed",
      issueType: detectedIssueType,
      status: "waiting_for_evidence",
      missingEvidence,
      consumedAt: new Date().toISOString()
    });
    return { outcome: "failed", status: "waiting_for_evidence", missingEvidence, plan: updatedPlan };
  }
  const binding = updatedPlan.taskBinding;
  if (!binding?.sessionId || !binding.workspace) {
    const message = "QA failure cannot continue because the original taskBinding sessionId/workspace is incomplete.";
    updatePlanFeedbackQaHandling(options.roleDir, latest, {
      outcome: "failed",
      issueType: detectedIssueType,
      status: "dispatch_failed",
      missingEvidence: [],
      consumedAt: new Date().toISOString(),
      message
    });
    throw new Error(message);
  }
  const dispatching = updatePlanFeedbackQaHandling(options.roleDir, latest, {
    outcome: "failed",
    issueType: detectedIssueType,
    status: "dispatching",
    missingEvidence: [],
    consumedAt: new Date().toISOString()
  });
  try {
    await options.sendToTask({
      threadId: binding.sessionId,
      cwd: binding.workspace,
      prompt: taskPrompt(updatedPlan, effectiveFeedback)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updatePlanFeedbackQaHandling(options.roleDir, dispatching, {
      ...dispatching.qaHandling!,
      status: "dispatch_failed",
      message
    });
    throw error;
  }
  updatePlanFeedbackQaHandling(options.roleDir, dispatching, {
    ...dispatching.qaHandling!,
    status: "dispatched"
  });
  return { outcome: "failed", status: "dispatched", missingEvidence: [], plan: updatedPlan };
}
