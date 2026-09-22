/** 嵌入来源仅用于展示，不授予计划读取或修改权限。 */
export interface EmbeddedPlanHost {
  agentType: "dsh";
  sessionId: string;
}

/** 独立页面忽略嵌入上下文；缺少身份时不猜测当前会话。 */
export function embeddedPlanHost(framed: boolean, agent: unknown, session: unknown): EmbeddedPlanHost | undefined {
  return framed && agent === "dsh" && typeof session === "string" && session.trim()
    ? { agentType: "dsh", sessionId: session.trim() } : undefined;
}

/** 只列出实际绑定，按处理端和完整会话 ID 排除宿主自身。 */
export function visiblePlanAgentRoles(plan: {
  taskBinding?: { agentType?: string; sessionId?: string };
  secretaryBinding?: { agentType?: string; sessionId?: string };
}, host?: EmbeddedPlanHost): Array<"task" | "secretary"> {
  return (["task", "secretary"] as const).filter(role => {
    const binding = role === "task" ? plan.taskBinding : plan.secretaryBinding;
    return Boolean(binding?.sessionId) && !(host && binding?.agentType === host.agentType && binding.sessionId === host.sessionId);
  });
}
