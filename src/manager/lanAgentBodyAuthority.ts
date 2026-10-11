import type { InstanceAgent } from "../shared/agentInstance.js";
import type { IncomingMessage } from "node:http";
import type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";

export type TrustedLanAgentSource = { nodeId: string; agentId: string; provider: AgentAdapterType; sessionId: string; sessionName: string; workspace?: string };
const sources = new WeakMap<IncomingMessage, TrustedLanAgentSource>();
export function setTrustedLanAgentSource(request: IncomingMessage, source: TrustedLanAgentSource): void { sources.set(request, Object.freeze({ ...source })); }
export function getTrustedLanAgentSource(request: IncomingMessage): TrustedLanAgentSource | undefined {
  assertTrustedLanAgentPrincipal(request);
  return sources.get(request);
}
const guards = new WeakMap<IncomingMessage, (body: unknown) => void>();
export function registerLanAgentBodyGuard(request: IncomingMessage, guard: (body: unknown) => void): void { guards.set(request, guard); }
export function hasLanAgentBodyGuard(request: IncomingMessage): boolean { return guards.has(request); }
export function validateLanAgentRequestBody(request: IncomingMessage, body: unknown): void {
  const principal = assertTrustedLanAgentPrincipal(request);
  const guard = guards.get(request);
  if (principal && !guard) throw new Error("Remote Agent body authority guard is unavailable.");
  guard?.(body);
}

/** Source claims are bound to the authenticated computer and selected registered Agent. */
export function assertLanAgentBodyAuthority(target: string, body: unknown,
  agent: Partial<InstanceAgent> | undefined): void {
  const send = target === "/api/agent/send";
  const threads = target === "/api/agent/threads";
  const outcome = /^\/api\/message-processing\/requirements\/[^/]+\/outcome$/.test(target);
  const context = target === "/api/codex-hook/context"
    || /^\/api\/lan-agent\/instances\/[^/]+\/agents\/[^/]+\/context$/.test(target);
  // Business payload schemas belong to their handlers. Future APIs may use
  // arrays, scalar values, or target fields named sender/worker/context.
  if (!send && !threads && !outcome && !context) return;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid remote Agent request body.");
  const value = body as Record<string, unknown>;
  const threadDelivery = threads && (value.action === "send" || (value.action === "create" && Boolean(value.prompt)));
  if (threads && !threadDelivery) return;
  const provider = agent?.provider === "codex-desktop" ? "codex" : agent?.provider;
  const sessions = new Set([agent?.sessionId, ...(agent?.managedSessionIds ?? [])].filter(Boolean));
  const session = (id: unknown) => { if (typeof id !== "string" || !sessions.has(id)) throw new Error("Remote Agent source session is not owned by this Agent."); };
  if (threadDelivery && value.sourceThreadId !== undefined) session(value.sourceThreadId);
  if (outcome && value.decidedByThreadId !== undefined) session(value.decidedByThreadId);
  if (send && value.sender !== undefined) {
    if (!value.sender || typeof value.sender !== "object") throw new Error("Invalid remote Agent sender.");
    session((value.sender as Record<string, unknown>).sessionId);
  }
  if (threadDelivery && value.messageSource !== undefined) {
    const source = value.messageSource as Record<string, unknown>;
    if (!source || source.type !== "agent" || source.agentAdapter !== provider) throw new Error("Remote Agent cannot impersonate a system, plan or message adapter source.");
    session(source.sessionId);
    if (value.sourceThreadId !== undefined && value.sourceThreadId !== source.sessionId) throw new Error("Remote Agent source identities do not match.");
  }
  if (send && value.sender === undefined) throw new Error("Remote Agent sender is required.");
  if (threadDelivery) {
    if (value.messageSource === undefined || value.sourceThreadId === undefined) throw new Error("Remote Agent delivery requires its authenticated source session.");
  }
  if (context) {
    session(value.session_id ?? value.sessionId);
    if (target === "/api/codex-hook/context") {
      const hookProvider = typeof value.agentType === "string" && value.agentType.trim() ? value.agentType.trim() : "codex";
      if (hookProvider !== provider) throw new Error("Remote Agent hook provider does not match its authenticated source.");
    }
  }
}
