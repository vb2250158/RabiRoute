import type { AgentAdapterType } from "./agentAdapterCapabilities.js";
import { agentIdentityForMessageSource, normalizeRabiMessageSource } from "./rabiMessage.js";

/** Historical attribution only; never an authentication or authorization grant. */
export type PlanHistoryActor = {
  kind: "agent" | "user" | "system" | "unknown";
  agentType?: string;
  sessionId?: string;
  displayName?: string;
  channel?: string;
  workspace?: string;
  baseUrl?: string;
};

/** Preserve only recorded attribution, without inferring identity from a plan. */
export function normalizePlanHistoryActor(value: unknown): PlanHistoryActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "agent" && raw.kind !== "user" && raw.kind !== "system" && raw.kind !== "unknown") return undefined;
  const actor: PlanHistoryActor = { kind: raw.kind };
  for (const key of ["agentType", "sessionId", "displayName", "channel", "workspace", "baseUrl"] as const) {
    const text = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (text && text.length <= 2000 && !/[\r\n\u2028\u2029]/.test(text)) actor[key] = text;
  }
  if (actor.kind === "agent" && (!actor.agentType || !actor.sessionId)) return undefined;
  return actor;
}

/** Resolve a declared source against its owner; this does not authenticate the caller. */
export async function resolvePlanHistoryActor(
  messageSource: unknown,
  options: {
    verifiedUserEntry?: boolean;
    readAgent: (identity: { agentAdapter: AgentAdapterType; sessionId: string; workspace?: string }) => Promise<{
      id: string; title: string; cwd?: string; archived?: boolean; baseUrl?: string;
    }>;
  }
): Promise<PlanHistoryActor> {
  if (messageSource == null) return { kind: "unknown" };
  if (typeof messageSource === "object" && (messageSource as { type?: unknown }).type === "user") {
    return options.verifiedUserEntry ? { kind: "user", displayName: "用户", channel: "webgui" } : { kind: "unknown" };
  }
  const source = normalizeRabiMessageSource(messageSource);
  const identity = agentIdentityForMessageSource(source);
  if (!identity) return { kind: "unknown" };
  const owner = await options.readAgent(identity);
  if (owner.id !== identity.sessionId || owner.archived || !owner.title) {
    throw new Error("Plan history messageSource owner is invalid or archived.");
  }
  return {
    kind: "agent",
    agentType: identity.agentAdapter,
    sessionId: owner.id,
    displayName: owner.title,
    channel: identity.agentAdapter,
    ...(owner.cwd ? { workspace: owner.cwd } : {}),
    ...(owner.baseUrl ? { baseUrl: owner.baseUrl } : {})
  };
}
