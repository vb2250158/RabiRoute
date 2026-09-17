import type { PlanAssistantAgentType } from "./agentAdapterCapabilities.js";

export const codexSessionInitializationMessage = [
  "这是由 RabiRoute 用户显式发起的 Codex Desktop 会话初始化消息。",
  "请先读取本消息附带的“角色和路径”“记忆与计划”“处理前上下文确认”等人格资料，尤其是角色文件与要求优先读取的条目，并把它们作为本会话后续工作的角色与上下文真源。",
  "实际消息必须继续由当前 Codex/ChatGPT Desktop owner 执行，以沿用该任务的模型、工具、权限与实时状态；不要启动或建议备用 Runtime。",
  "本次只完成上下文初始化，不执行外部动作，也不修改文件。读取完成后请在当前会话简短确认已完成初始化。"
].join("\n\n");

export type CodexSessionInitializationDelivery = {
  gatewayId: string;
  text: string;
};

export async function initializeCodexSessionForRoute(params: {
  save: () => Promise<void>;
  currentGatewayId: () => string;
  deliver: (message: CodexSessionInitializationDelivery) => Promise<void>;
}): Promise<{ gatewayId: string }> {
  // Saving is the canonical resolve/create transaction. It persists the
  // visible name + opaque task id before the first initialization message.
  await params.save();
  const gatewayId = params.currentGatewayId().trim();
  if (!gatewayId) throw new Error("保存后没有可初始化的 RabiRoute 路由。");
  await params.deliver({ gatewayId, text: codexSessionInitializationMessage });
  return { gatewayId };
}
/** The conversation this message opens is owned by Antigravity Desktop. */
export const antigravitySessionInitializationMessage = [
  "这是由 RabiRoute 用户显式发起的 Antigravity 会话初始化消息。",
  "请先读取本消息附带的角色、路径、计划、记忆和必读项，并把它们作为本会话后续工作的角色与上下文真源。",
  "后续消息由 RabiRoute 通过 agy agentapi 投递到本会话，不属于你或其他 Agent 端；请继续由当前 Antigravity 会话 owner 执行，以沿用本会话的模型、工具、权限与工作区状态。",
  "本会话安装的 RabiRoute 插件会以注入步骤的形式补充角色与上下文，并汇报工具使用与轮次结束事件；不要因此改投其它 Agent 端。",
  "本次只完成上下文初始化，不执行外部动作，也不修改文件。读取完成后请在当前会话简短确认已完成初始化。"
].join("\n\n");

export function agentSessionInitializationMessage(agentAdapter: PlanAssistantAgentType): string {
  if (agentAdapter === "codex") return codexSessionInitializationMessage;
  if (agentAdapter === "antigravity") return antigravitySessionInitializationMessage;
  return [
    "这是由 RabiRoute 用户显式发起的 DSH 会话初始化消息。",
    "请先读取本消息附带的角色、路径、计划、记忆和必读项，并把它们作为本会话后续工作的角色与上下文真源。",
    "实际消息继续由当前 DSH 会话 owner 执行，并使用已安装的 RabiRoute Agent 插件访问会话、计划、记忆、消息处理和 Agent 间通信能力；不要改投其它 Agent 端。",
    "本次只完成上下文初始化，不执行外部动作，也不修改文件。读取完成后请在当前会话简短确认已完成初始化。"
  ].join("\n\n");
}

export async function initializeAgentSessionForRoute(params: {
  agentAdapter: PlanAssistantAgentType;
  save: () => Promise<void>;
  currentGatewayId: () => string;
  deliver: (message: CodexSessionInitializationDelivery) => Promise<void>;
}): Promise<{ gatewayId: string }> {
  await params.save();
  const gatewayId = params.currentGatewayId().trim();
  if (!gatewayId) throw new Error("保存后没有可初始化的 RabiRoute 路由。");
  await params.deliver({ gatewayId, text: agentSessionInitializationMessage(params.agentAdapter) });
  return { gatewayId };
}
