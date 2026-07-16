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
