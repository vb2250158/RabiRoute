export type AgentAdapterType = "codex" | "copilotCli" | "marvis" | "astrbot";

export type ManagedTaskAgentFeature =
  | "messageProcessingAgent"
  | "planAssistantSessions"
  | "memoryConsolidationAgent"
  | "hooks";

export type AgentAdapterCapabilities = {
  managedTasks?: Partial<Record<ManagedTaskAgentFeature, true>>;
};

const baseAgentCapabilities: AgentAdapterCapabilities = Object.freeze({});

const codexManagedTaskCapabilities: AgentAdapterCapabilities = Object.freeze({
  managedTasks: Object.freeze({
    messageProcessingAgent: true,
    planAssistantSessions: true,
    memoryConsolidationAgent: true,
    hooks: true
  })
});

const capabilitiesByAgentType: Readonly<Record<AgentAdapterType, AgentAdapterCapabilities>> = Object.freeze({
  codex: codexManagedTaskCapabilities,
  copilotCli: baseAgentCapabilities,
  marvis: baseAgentCapabilities,
  astrbot: baseAgentCapabilities
});

export function agentAdapterCapabilities(type: AgentAdapterType): AgentAdapterCapabilities {
  return capabilitiesByAgentType[type];
}

export function agentAdapterSupportsManagedTaskFeature(
  type: AgentAdapterType,
  feature: ManagedTaskAgentFeature
): boolean {
  return agentAdapterCapabilities(type).managedTasks?.[feature] === true;
}
