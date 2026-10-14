export const agentThreadSourceTypes = ["primary_persona", "message_processing", "plan_secretary", "plan_agent", "agent"] as const;
export type AgentThreadSourceType = typeof agentThreadSourceTypes[number];

export class AgentThreadContractError extends Error {
  constructor(message: string, readonly field: string, readonly stage: "validation" | "source_verification", readonly repair: string,
    readonly code = "AGENT_THREAD_CONTRACT_INVALID") {
    super(message);
    this.name = "AgentThreadContractError";
  }
}

/** Owner IDs are opaque: preserve their complete bytes instead of guessing a provider from their shape. */
export function completeAgentSessionId(value: unknown, field: "sourceThreadId" | "threadId"): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 4096 || /[\0\r\n\u2028\u2029]/.test(value)) {
    throw new AgentThreadContractError("Complete opaque session ID is required.", field,
      field === "sourceThreadId" ? "source_verification" : "validation",
      `Supply the complete existing ${field === "sourceThreadId" ? "source" : "target"} owner's session ID without trimming or substitution.`,
      "AGENT_SESSION_ID_REQUIRED");
  }
  return value;
}

export function normalizeAgentThreadSourceType(value: unknown, required = false): AgentThreadSourceType {
  if (value == null || value === "") {
    if (!required) return "agent";
    throw new AgentThreadContractError("Source Agent type is required.", "sourceAgentType", "source_verification",
      "Supply the actual source role; use agent for an ordinary Agent session.", "AGENT_SOURCE_TYPE_REQUIRED");
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 40 || !(agentThreadSourceTypes as readonly string[]).includes(normalized)) {
    throw new AgentThreadContractError("Invalid sourceAgentType. Expected primary_persona, message_processing, plan_secretary, plan_agent, or agent.",
      "sourceAgentType", "source_verification", "Select one of the documented source roles.", "AGENT_SOURCE_TYPE_INVALID");
  }
  return normalized as AgentThreadSourceType;
}

export function callerAgentDeliveryId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 100 || /[\0\r\n\u2028\u2029]/.test(value)) {
    throw new AgentThreadContractError("Invalid deliveryId for Agent delivery.", "deliveryId", "validation",
      "Use one stable non-empty deliveryId of at most 100 characters for this operation; retain it on retries.");
  }
  return value;
}
