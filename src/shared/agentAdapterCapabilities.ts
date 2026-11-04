import { installedAgentAdapterManifests } from "./agentAdapterManifests.generated.js";

/** Stable wire IDs are open; availability comes from the native provider graph. */
export type AgentAdapterType = string;
export const agentAdapterTypes: readonly AgentAdapterType[] = installedAgentAdapterManifests.map(item => item.type);

export type ManagedTaskAgentFeature =
  | "messageProcessingAgent"
  | "planAssistantSessions"
  | "memoryConsolidationAgent"
  | "hooks"
  /**
   * The adapter's owner exposes a session surface RabiRoute can enumerate, read
   * and deliver into on its own, so the Agent thread bridge can address one
   * session of that adapter by id.
   *
   * Deliberately separate from `planAssistantSessions`: hosting an addressable
   * session is not the same as being eligible to hold a Plan role or run memory
   * consolidation. Folding the two together would have opened those paths to
   * adapters whose delivery is a handoff into someone else's runtime.
   */
  | "agentThreads"
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

let manifestReader: (() => readonly AgentAdapterManifest[]) | undefined;

/** Install the owning native generation accessor, never a parallel enabled table. */
export function installAgentAdapterManifestReader(reader: () => readonly AgentAdapterManifest[]): () => void {
  const previous = manifestReader;
  manifestReader = reader;
  return () => { if (manifestReader === reader) manifestReader = previous; };
}

export function isAgentAdapterType(value: unknown): value is AgentAdapterType {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);
}

export function listAgentAdapterManifests(): AgentAdapterManifest[] {
  return [...(manifestReader ? manifestReader() : installedAgentAdapterManifests)] as AgentAdapterManifest[];
}

export function agentAdapterManifest(type: AgentAdapterType): AgentAdapterManifest {
  return listAgentAdapterManifests().find(item => item.type === type) ?? {
    type, label: type, maturity: "experimental", transport: { protocol: "unavailable", mode: "unavailable" }, capabilities: {}
  };
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

/**
 * Adapters whose owner can host a Plan assistant session, i.e. hold a durable
 * session that RabiRoute can bind a Plan role to and deliver into later.
 *
 * Plan bindings persist `agentType` verbatim and re-open the bound session by id,
 * so this list is what keeps a binding from being written back as some other
 * adapter. Describe the capability here rather than enumerating adapter names at
 * each call site: a new adapter then becomes eligible by declaring the feature.
 */
export const planAssistantAgentTypes = agentAdapterTypes.filter(
  (type) => agentAdapterCapabilities(type).managedTasks?.planAssistantSessions === true
);

export type PlanAssistantAgentType = typeof agentAdapterTypes[number];

export function isPlanAssistantAgentType(value: unknown): value is PlanAssistantAgentType {
  const normalized = typeof value === "string" ? value.trim() : "";
  return Boolean(normalized)
    && isAgentAdapterType(normalized)
    && agentAdapterSupportsManagedTaskFeature(normalized, "planAssistantSessions");
}

/**
 * Adapters whose owner can be addressed session-by-session through the Agent
 * thread bridge.
 *
 * Kept apart from {@link planAssistantAgentTypes}: the bridge needs only an
 * addressable session surface, while a Plan binding additionally promises that
 * RabiRoute can hold a role inside that session. An adapter that hands the turn
 * to a foreign runtime declares this one alone.
 */
export const agentThreadCapableAgentTypes = agentAdapterTypes.filter(
  (type) => agentAdapterCapabilities(type).managedTasks?.agentThreads === true
);

export function isAgentThreadCapableAdapter(value: unknown): value is AgentAdapterType {
  const normalized = typeof value === "string" ? value.trim() : "";
  return Boolean(normalized)
    && isAgentAdapterType(normalized)
    && agentAdapterSupportsManagedTaskFeature(normalized, "agentThreads");
}

/**
 * Normalize a persisted binding's `agentType`, preserving the adapter that
 * actually owns the session.
 *
 * `fallback` is the value used when the field is absent, which only happens for
 * bindings written before adapter tagging existed. It must never be applied to a
 * present-but-unrecognized value: silently rewriting an unknown adapter to the
 * fallback would deliver into a session of the wrong kind.
 */
export function normalizePlanBindingAgentType(
  value: unknown,
  fallback: PlanAssistantAgentType = "codex"
): PlanAssistantAgentType {
  if (value == null || typeof value === "string" && !value.trim()) return fallback;
  const normalized = typeof value === "string" ? value.trim() : "";
  // This is deserialization of an existing identity. Creation and execution
  // validate declared features and the active native provider at their owners.
  if (isAgentAdapterType(normalized)) return normalized;
  throw new Error("Invalid plan binding Agent type.");
}
