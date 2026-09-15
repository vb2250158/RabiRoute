export const agentAdapterTypes = ["codex", "copilotCli", "marvis", "astrbot", "dsh", "workbuddy"] as const;

export type AgentAdapterType = typeof agentAdapterTypes[number];

export type ManagedTaskAgentFeature =
  | "messageProcessingAgent"
  | "planAssistantSessions"
  | "memoryConsolidationAgent"
  | "hooks"
  /**
   * The adapter transport keeps a durable, locally readable log of inbound
   * prompts, so a lost delivery receipt can be reconstructed after the fact.
   * Codex Desktop writes rollout files; an HTTP transport that only returns a
   * one-shot acceptance receipt does not qualify.
   */
  | "deliveryReceiptRecovery";

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

/**
 * Adapters whose transport can carry message-processing deliveries and whose
 * owner publishes lifecycle hooks, but whose plan-assistant /
 * memory-consolidation paths are not implemented yet. Declaring only verified
 * features keeps the capability gates honest instead of offering panels whose
 * API calls would fail.
 */
const messageAndHookCapabilities: AgentAdapterCapabilities = Object.freeze({
  managedTasks: Object.freeze<Partial<Record<ManagedTaskAgentFeature, true>>>({
    messageProcessingAgent: true,
    hooks: true
  })
});

/** Codex Desktop persists inbound prompts to rollout files; its transport is the only receipt-recoverable one. */
const codexTaskCapabilities: AgentAdapterCapabilities = Object.freeze({
  managedTasks: Object.freeze<Partial<Record<ManagedTaskAgentFeature, true>>>({
    messageProcessingAgent: true,
    planAssistantSessions: true,
    memoryConsolidationAgent: true,
    hooks: true,
    deliveryReceiptRecovery: true
  })
});

const manifestsByAgentType = Object.freeze({
  codex: Object.freeze({
    type: "codex",
    label: "Codex（ChatGPT 中的编码 Agent）",
    maturity: "verified",
    transport: Object.freeze({ protocol: "Codex Desktop IPC", mode: "desktop-owner" }),
    host: Object.freeze({ name: "Codex/ChatGPT Desktop", required: true }),
    capabilities: codexTaskCapabilities
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
  }),
  workbuddy: Object.freeze({
    type: "workbuddy",
    label: "WorkBuddy（腾讯 AI 办公工作台）",
    // Delivery is implemented and verified for same-id redelivery, and the hook
    // package installs through the WorkBuddy user settings file. The desktop
    // pairing handoff for the gateway credential is still manual, so this stays
    // experimental. Plan assistants and memory consolidation stay undeclared:
    // they go through the Codex/DSH thread driver. No `deliveryReceiptRecovery`
    // either — the gateway returns a one-shot acceptance receipt and keeps no
    // readable inbound log.
    maturity: "experimental",
    transport: Object.freeze({ protocol: "http", mode: "session-gateway" }),
    host: Object.freeze({ name: "WorkBuddy Desktop", required: true }),
    capabilities: messageAndHookCapabilities
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

/**
 * An adapter can drive managed Plan lifecycle only when it emits lifecycle hooks.
 * The wire value is optional: a hook request without `agentType` predates
 * adapter tagging and is treated as Codex, which is the only untagged producer.
 */
export function agentAdapterSupportsLifecycleHooks(type: string | undefined): boolean {
  const normalized = String(type || "").trim();
  if (!normalized) return true;
  return isAgentAdapterType(normalized) && agentAdapterSupportsManagedTaskFeature(normalized, "hooks");
}

/**
 * Reconstructing a lost delivery receipt requires a durable inbound-prompt log on
 * the adapter transport. Adapters without one report `adapter_has_no_receipt_log`
 * instead of silently degrading to an unprovable `in_progress` / `missing` state.
 */
export function agentAdapterSupportsReceiptRecovery(type: string | undefined): boolean {
  const normalized = String(type || "").trim();
  return isAgentAdapterType(normalized)
    && agentAdapterSupportsManagedTaskFeature(normalized, "deliveryReceiptRecovery");
}
