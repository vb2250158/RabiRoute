export const agentAdapterTypes = ["codex", "copilotCli", "marvis", "astrbot", "dsh"] as const;

export type AgentAdapterType = typeof agentAdapterTypes[number];

export type ManagedTaskAgentFeature =
  | "messageProcessingAgent"
  | "planAssistantSessions"
  | "memoryConsolidationAgent"
  | "hooks";

export type AgentAdapterCapabilities = {
  managedTasks?: Partial<Record<ManagedTaskAgentFeature, true>>;
};

export type AgentAdapterMaturity = "verified" | "experimental" | "stub";

export type AgentAdapterManifest = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentAdapterMaturity;
  transport: { protocol: string; mode: string };
  host?: { name: string; required: boolean };
  capabilities: AgentAdapterCapabilities;
};

const baseAgentCapabilities: AgentAdapterCapabilities = Object.freeze({});

const managedTaskCapabilities: AgentAdapterCapabilities = Object.freeze({
  managedTasks: Object.freeze({
    messageProcessingAgent: true,
    planAssistantSessions: true,
    memoryConsolidationAgent: true,
    hooks: true
  })
});

const manifestsByAgentType = Object.freeze({
  codex: Object.freeze({
    type: "codex",
    label: "Codex（ChatGPT 中的编码 Agent）",
    maturity: "verified",
    transport: Object.freeze({ protocol: "Codex Desktop IPC", mode: "desktop-owner" }),
    host: Object.freeze({ name: "Codex/ChatGPT Desktop", required: true }),
    capabilities: managedTaskCapabilities
  }),
  copilotCli: Object.freeze({
    type: "copilotCli",
    label: "Copilot CLI",
    maturity: "experimental",
    transport: Object.freeze({ protocol: "process", mode: "copilot-cli" }),
    capabilities: baseAgentCapabilities
  }),
  marvis: Object.freeze({
    type: "marvis",
    label: "Marvis",
    maturity: "stub",
    transport: Object.freeze({ protocol: "manual", mode: "open-or-copy" }),
    capabilities: baseAgentCapabilities
  }),
  astrbot: Object.freeze({
    type: "astrbot",
    label: "AstrBot",
    maturity: "experimental",
    transport: Object.freeze({ protocol: "http", mode: "astrbot-plugin" }),
    capabilities: baseAgentCapabilities
  }),
  dsh: Object.freeze({
    type: "dsh",
    label: "DSH（DeepSeek Harness）",
    maturity: "experimental",
    transport: Object.freeze({ protocol: "http", mode: "session.list/create/rename/prompt" }),
    host: Object.freeze({ name: "DSH apiproxy", required: true }),
    capabilities: managedTaskCapabilities
  })
}) satisfies Readonly<Record<AgentAdapterType, AgentAdapterManifest>>;

export function isAgentAdapterType(value: unknown): value is AgentAdapterType {
  return typeof value === "string" && agentAdapterTypes.includes(value as AgentAdapterType);
}

export function agentAdapterManifest(type: AgentAdapterType): AgentAdapterManifest {
  return manifestsByAgentType[type];
}

export function listAgentAdapterManifests(): AgentAdapterManifest[] {
  return agentAdapterTypes.map((type) => manifestsByAgentType[type]);
}

export function agentAdapterCapabilities(type: AgentAdapterType): AgentAdapterCapabilities {
  return agentAdapterManifest(type).capabilities;
}

export function agentAdapterSupportsManagedTaskFeature(
  type: AgentAdapterType,
  feature: ManagedTaskAgentFeature
): boolean {
  return isAgentAdapterType(type)
    && agentAdapterCapabilities(type).managedTasks?.[feature] === true;
}
