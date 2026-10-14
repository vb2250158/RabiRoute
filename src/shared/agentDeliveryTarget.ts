import { isAgentAdapterType, type AgentAdapterType } from "./agentAdapterCapabilities.js";

export type AgentDeliveryExecutor = "primary" | "plan_secretary" | "message_pool" | "memory_consolidation";
export type AgentRecipientDefinition = { id: string; name: string; executor: AgentDeliveryExecutor };
export type AgentSessionDestination = {
  kind: "session";
  agentTargetId: string;
  agentAdapter: AgentAdapterType;
  sessionId: string;
  sessionName: string;
  workspace: string;
};
export type AgentDeliveryTarget = { kind: "recipient"; recipientId: string } | AgentSessionDestination;

/** Initial configuration only. Runtime selection always reads the saved rule. */
export function defaultAgentRecipients(): AgentRecipientDefinition[] {
  return [
    { id: "primary", name: "主人格", executor: "primary" },
    { id: "plan-secretary", name: "计划秘书", executor: "plan_secretary" },
    { id: "message-processing", name: "消息处理 Agent", executor: "message_pool" },
    { id: "memory-consolidation", name: "记忆整理 Agent", executor: "memory_consolidation" }
  ];
}

export function primaryDeliveryTarget(): AgentDeliveryTarget {
  return { kind: "recipient", recipientId: "primary" };
}

export function normalizeAgentDeliveryTarget(value: unknown): AgentDeliveryTarget {
  if (value === undefined) return primaryDeliveryTarget();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agent delivery target.");
  const raw = value as Record<string, unknown>;
  const text = (key: string) => typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  if (raw.kind === "recipient" && text("recipientId")) return { kind: "recipient", recipientId: text("recipientId") };
  if (raw.kind === "session" && isAgentAdapterType(raw.agentAdapter)) {
    return { kind: "session", agentTargetId: text("agentTargetId"), agentAdapter: raw.agentAdapter,
      sessionId: text("sessionId"), sessionName: text("sessionName"), workspace: text("workspace") };
  }
  throw new Error("Select an Agent recipient or a complete Agent/session binding.");
}

export function validateAgentDeliveryTarget(target: AgentDeliveryTarget): void {
  if (target.kind === "session" && (!target.agentTargetId || !target.sessionId || !target.sessionName)) {
    throw new Error("Select an Agent instance and target session before saving.");
  }
}

export function normalizeAgentRecipients(value: unknown): AgentRecipientDefinition[] {
  if (value === undefined) return defaultAgentRecipients();
  if (!Array.isArray(value)) throw new Error("Agent recipients must be a list.");
  const ids = new Set<string>();
  return value.map(entry => {
    const raw = entry as Partial<AgentRecipientDefinition> | null;
    if (!raw || !raw.id?.trim() || !raw.name?.trim()
      || !["primary", "plan_secretary", "message_pool", "memory_consolidation"].includes(raw.executor || "")) {
      throw new Error("Invalid Agent recipient configuration.");
    }
    const id = raw.id.trim();
    if (ids.has(id)) throw new Error(`Duplicate Agent recipient: ${id}`);
    ids.add(id);
    return { id, name: raw.name.trim(), executor: raw.executor! };
  });
}

export function resolveAgentDeliveryExecutor(target: AgentDeliveryTarget, recipients: readonly AgentRecipientDefinition[]): AgentDeliveryExecutor | "session" {
  if (target.kind === "session") return "session";
  const recipient = recipients.find(item => item.id === target.recipientId);
  if (!recipient) throw new Error(`Agent recipient is not configured: ${target.recipientId}`);
  return recipient.executor;
}
