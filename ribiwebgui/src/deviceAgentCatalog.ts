import { normalizeAgentInstanceBinding, normalizeInstanceAgents, type AgentInstance } from "@shared/agentInstance";

/** Device identity comes from its PC owner catalog, never from a display name or LAN registry id. */
export function deviceAgentInstanceFromCatalog(value: unknown): AgentInstance | undefined {
  const catalog = value as { ownerInstanceId?: unknown; agents?: unknown } | null;
  if (!catalog || typeof catalog.ownerInstanceId !== "string" || !catalog.ownerInstanceId.trim()) {
    throw new Error("设备 Agent 未配置：请在设备设置中绑定人格和所属电脑后刷新。");
  }
  const identity = normalizeAgentInstanceBinding({ instanceId: catalog.ownerInstanceId, agentId: "catalog" })!;
  const agents = normalizeInstanceAgents(catalog.agents);
  if (agents.some(agent => agent.provider !== "deviceAgent")) throw new Error("设备目录返回了不匹配的 Agent 类型，请刷新核对。");
  if (!agents.length) return undefined;
  return { instanceId: identity.instanceId, name: "设备所属电脑", local: true, connected: true, agents };
}
