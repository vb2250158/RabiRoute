import { normalizeAgentDeliveryTarget, resolveAgentDeliveryExecutor, validateAgentDeliveryTarget, type AgentDeliveryTarget, type AgentRecipientDefinition, type AgentSessionDestination } from "../shared/agentDeliveryTarget.js";

export type AgentDeliveryHandlers<T> = {
  primary: () => Promise<T>;
  plan_secretary: () => Promise<T>;
  message_pool: () => Promise<T>;
  memory_consolidation: () => Promise<T>;
  session: (target: AgentSessionDestination) => Promise<T>;
};

/** Rule selection has already happened. Execution cannot replace the selected recipient. */
export async function executeAgentDelivery<T>(
  value: AgentDeliveryTarget | undefined,
  recipients: readonly AgentRecipientDefinition[],
  handlers: AgentDeliveryHandlers<T>
): Promise<T> {
  if (value === undefined) throw new Error("Automation rule has no Agent delivery target; migrate or save its configuration.");
  const target = normalizeAgentDeliveryTarget(value);
  validateAgentDeliveryTarget(target);
  const executor = resolveAgentDeliveryExecutor(target, recipients);
  if (target.kind === "session") return handlers.session(structuredClone(target));
  if (executor === "session") throw new Error("Recipient does not resolve to a managed Agent.");
  return handlers[executor]();
}
