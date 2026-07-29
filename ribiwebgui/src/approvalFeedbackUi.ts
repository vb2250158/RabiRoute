const FETCH_FAILURE_PATTERN = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i;

export function planFeedbackSubmissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error || "").trim();
  if (FETCH_FAILURE_PATTERN.test(message)) {
    return "无法连接 Manager，服务可能正在重启或网络暂时中断。计划反馈内容已保留，请稍后重试。";
  }
  return message || "提交计划反馈失败，请稍后重试。";
}

export const approvalSubmissionErrorMessage = planFeedbackSubmissionErrorMessage;
