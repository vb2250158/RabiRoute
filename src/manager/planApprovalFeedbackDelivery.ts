import type { PlanFeedbackRecord } from "../planFeedback.js";
import type { PlanItem } from "../roleKnowledge.js";

export type PlanApprovalFeedbackTaskRequest = {
  threadId: string;
  cwd: string;
  prompt: string;
};

export type PlanApprovalFeedbackPersonaRequest = {
  kind: "auto_delivered_notice" | "auto_delivery_pending_notice" | "auto_delivery_failed_notice" | "full_feedback";
  text: string;
};

export type DeliverPlanApprovalFeedbackOptions = {
  roleId: string;
  managerBaseUrl: string;
  plan: PlanItem;
  feedback: PlanFeedbackRecord;
  sendToTask: (request: PlanApprovalFeedbackTaskRequest) => Promise<void>;
  sendToPersona: (request: PlanApprovalFeedbackPersonaRequest) => Promise<void>;
  directRetryAttempts?: number;
  directRetryDelayMs?: number;
};

export type PlanApprovalFeedbackDeliveryResult = {
  mode: "bound_task" | "persona_fallback";
  message?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableBoundTaskDeliveryError(error: unknown): boolean {
  const text = errorMessage(error).toLocaleLowerCase();
  return text.includes("no-client-found")
    || text.includes("desktop owner")
    || text.includes("owner 没有完成加载")
    || text.includes("desktop 未就绪")
    || text.includes("ipc is not connected");
}

function isGuidance(feedback: PlanFeedbackRecord): boolean {
  return feedback.kind === "guidance" || feedback.kind === "guidance_response";
}

function feedbackLabel(feedback: PlanFeedbackRecord): string {
  return isGuidance(feedback) ? "执行引导" : "审批意见";
}

function responseKind(feedback: PlanFeedbackRecord): "guidance_response" | "approval_response" {
  return isGuidance(feedback) ? "guidance_response" : "approval_response";
}

function feedbackLines(feedback: PlanFeedbackRecord): string[] {
  const lines = [
    `计划：${feedback.planTitle}`,
    `计划 ID：${feedback.planId}`,
    `反馈 ID：${feedback.id}`
  ];
  if (feedback.stepId || feedback.stepTitle) {
    lines.push(`对应步骤：${feedback.stepTitle || feedback.stepId}${feedback.stepId ? `（${feedback.stepId}）` : ""}`);
  }
  const label = feedbackLabel(feedback);
  lines.push(`${label}：${feedback.text}`);
  if (feedback.attachments.length) {
    lines.push(
      `${label}附件：`,
      ...feedback.attachments.map((attachment) => `- ${attachment.name}（${attachment.path}）`)
    );
  }
  if (feedback.planAttachments.length) {
    lines.push(
      "本次 @ 的计划附件：",
      ...feedback.planAttachments.map((attachment) => `- ${attachment.name}（${attachment.path}）`)
    );
  }
  return lines;
}

function feedbackApiUrl(options: DeliverPlanApprovalFeedbackOptions): string {
  return `${options.managerBaseUrl}/api/roles/${encodeURIComponent(options.roleId)}/plans/${encodeURIComponent(options.plan.id)}/feedback`;
}

function boundTaskPrompt(options: DeliverPlanApprovalFeedbackOptions): string {
  if (isGuidance(options.feedback)) {
    return [
      "[计划引导：已直接投递到绑定业务会话]",
      ...feedbackLines(options.feedback),
      "这是该计划绑定的原业务任务。请直接消费本次引导，不要等待人格 Agent 再次转发，也不要创建重复计划或替代会话。",
      "请先读取 Manager 中的当前计划与反馈记录，再结合用户引导继续推进。引导属于整个计划，不绑定某个步骤；若它改变了范围、优先级、执行方法或后续路径，请显式 PATCH 计划，并同步调整尚未开始的步骤。引导记录本身不自动改变计划状态，也不代表审批。",
      `处理完成后，向 ${feedbackApiUrl(options)} POST 一条 kind=${responseKind(options.feedback)}、author=agent、source=agent、notifyAgent=false 的处理说明，只回写当前 planId，不要携带 stepId；不要只在本任务里输出正文。`
    ].join("\n");
  }
  return [
    "[计划审批：已直接投递到绑定业务会话]",
    ...feedbackLines(options.feedback),
    "这是该计划绑定的原业务任务。请直接消费本次审批，不要等待人格 Agent 再次转发，也不要创建重复计划或替代会话。",
    "请先读取 Manager 中的当前计划与审批记录，再按审批意见显式更新对应计划或步骤；审批记录本身不自动推进计划。",
    "计划说明必须写具体：实际文件与改动、完整命令及影响、配置/数据/外部变更、验证、回退和明确排除范围。",
    `处理完成后，向 ${feedbackApiUrl(options)} POST 一条 kind=${responseKind(options.feedback)}、author=agent、source=agent、notifyAgent=false 的处理说明，回写当前 planId / stepId；不要只在本任务里输出正文。`
  ].join("\n");
}

function personaFeedbackText(
  options: DeliverPlanApprovalFeedbackOptions,
  directFailure?: string
): string {
  const guidance = isGuidance(options.feedback);
  return [
    guidance ? "[计划执行引导]" : "[计划审批建议]",
    ...feedbackLines(options.feedback),
    ...(directFailure ? [`绑定业务会话自动直投失败：${directFailure}`] : []),
    guidance
      ? "当前引导没有成功直达绑定业务会话，人格 Agent 请按原流程处理、记录并续投对应业务任务。"
      : "当前审批没有成功直达绑定业务会话，人格 Agent 请按原流程处理、记录并续投对应业务任务。",
    guidance
      ? "请先读取 Manager 中的当前计划与反馈记录，再结合引导继续推进；引导属于整个计划，必要时同步调整尚未开始的步骤。引导本身不自动改变计划状态，也不代表审批。"
      : "请先读取 Manager 中的当前计划与审批记录，再按意见更新计划或对应步骤；审批记录本身不自动推进计划。"
  ].join("\n");
}

function personaNoticeText(options: DeliverPlanApprovalFeedbackOptions): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动投递通知]`,
    ...feedbackLines(options.feedback),
    `系统已自动投递到绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    "无需再次转发或代替业务会话重复处理；人格 Agent 只需知悉，并按既有计划闭环复核后续结果。"
  ].join("\n");
}

function personaPendingNoticeText(options: DeliverPlanApprovalFeedbackOptions, failure: string): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动直投等待通知]`,
    ...feedbackLines(options.feedback),
    `已找到绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    `Desktop owner 暂时未接管该任务，系统正在对同一会话自动重试：${failure}`,
    `${label}仍保持 pending，尚未标记为 delivered。人格 Agent 无需代为转发、无需创建替代任务，也不要重复处理本次反馈。`
  ].join("\n");
}

function personaFailedNoticeText(options: DeliverPlanApprovalFeedbackOptions, failure: string): string {
  const binding = options.plan.taskBinding!;
  const label = isGuidance(options.feedback) ? "计划引导" : "计划审批";
  return [
    `[${label}自动直投失败通知]`,
    ...feedbackLines(options.feedback),
    `绑定业务会话：${binding.sessionTitle || binding.sessionId}`,
    `会话 ID：${binding.sessionId}`,
    `工作区：${binding.workspace}`,
    `系统完成有界重试后仍未成功交给 Desktop owner：${failure}`,
    `本次${label}未标记为已投递，也没有启动备用 Runtime、创建替代任务或把完整反馈回退给人格 Agent。请保留原 taskBinding，等待 Desktop owner 可用后重试。`
  ].join("\n");
}

export async function deliverPlanApprovalFeedback(
  options: DeliverPlanApprovalFeedbackOptions
): Promise<PlanApprovalFeedbackDeliveryResult> {
  const binding = options.plan.taskBinding;
  if (!binding?.sessionId?.trim() || !binding.workspace?.trim()) {
    await options.sendToPersona({
      kind: "full_feedback",
      text: personaFeedbackText(options)
    });
    return {
      mode: "persona_fallback",
      message: "Plan taskBinding sessionId/workspace is incomplete; delivered to persona."
    };
  }

  const taskRequest = {
    threadId: binding.sessionId.trim(),
    cwd: binding.workspace.trim(),
    prompt: boundTaskPrompt(options)
  };
  const retryAttempts = Math.max(1, Math.floor(options.directRetryAttempts ?? 12));
  const retryDelayMs = Math.max(1, Math.floor(options.directRetryDelayMs ?? 15_000));
  let lastError: unknown;
  let pendingNoticeFailure = "";

  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    try {
      await options.sendToTask(taskRequest);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableBoundTaskDeliveryError(error);
      if (attempt === 0 && retryable) {
        try {
          await options.sendToPersona({
            kind: "auto_delivery_pending_notice",
            text: personaPendingNoticeText(options, errorMessage(error))
          });
        } catch (noticeError) {
          pendingNoticeFailure = errorMessage(noticeError);
        }
      }
      if (!retryable || attempt + 1 >= retryAttempts) break;
      await wait(retryDelayMs);
    }
  }

  if (lastError !== undefined) {
    const message = errorMessage(lastError);
    try {
      await options.sendToPersona({
        kind: "auto_delivery_failed_notice",
        text: personaFailedNoticeText(options, message)
      });
    } catch {
      // The bound-task delivery failure remains authoritative even if its control-plane notice also fails.
    }
    throw new Error(message);
  }

  try {
    await options.sendToPersona({
      kind: "auto_delivered_notice",
      text: personaNoticeText(options)
    });
    return pendingNoticeFailure
      ? { mode: "bound_task", message: `Plan feedback reached the bound business task; pending persona notice failed earlier: ${pendingNoticeFailure}` }
      : { mode: "bound_task" };
  } catch (error) {
    return {
      mode: "bound_task",
      message: `Plan feedback reached the bound business task, but persona notification failed: ${errorMessage(error)}`
    };
  }
}
