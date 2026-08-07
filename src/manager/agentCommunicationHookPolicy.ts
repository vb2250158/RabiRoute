import type { CodexHookContextRequest } from "./codexHookContext.js";

const persistentTaskDeliveryTools = [
  "send_message_to_thread",
  "handoff_thread",
  "create_thread",
  "fork_thread"
];

export function isPersistentCodexTaskDeliveryTool(toolName: unknown): boolean {
  const normalized = String(toolName || "").trim().toLowerCase().replace(/[:.]/g, "_");
  return persistentTaskDeliveryTools.some((name) => normalized === name || normalized.endsWith(`_${name}`));
}

export function agentCommunicationToolDenial(
  request: CodexHookContextRequest,
  managedAgentSession: boolean
): { permissionDecision: "deny"; reason: string } | undefined {
  if (request.eventName !== "PreToolUse" || !managedAgentSession || !isPersistentCodexTaskDeliveryTool(request.toolName)) {
    return undefined;
  }
  return {
    permissionDecision: "deny",
    reason: [
      "当前任务属于 RabiRoute 管理的 Agent，不能使用 Codex 持久任务工具直接向其它任务投递消息。",
      "请改用 RabiRoute Agent 任务桥：POST /api/agent/threads，action=send。",
      "Agent 间投递必须填写 sourceThreadId、sourceAgentType 和 responsePolicy；responsePolicy 只允许 required 或 none。",
      "responsePolicy=required 时还必须填写 responseInstruction。",
      "回复已有请求时必须填写 inReplyToRequestId、result、nextAction，并再次明确 responsePolicy。",
      "示例：{\"action\":\"send\",\"threadId\":\"目标任务ID\",\"cwd\":\"目标工作目录\",\"sourceThreadId\":\"当前任务ID\",\"sourceAgentType\":\"plan_agent\",\"responsePolicy\":\"required\",\"responseInstruction\":\"请完成后回复结果和下一步\",\"prompt\":\"重新编写的投递内容\"}"
    ].join("\n")
  };
}
