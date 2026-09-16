import type { InstanceAgent } from "../shared/agentInstance.js";
import type { IncomingMessage } from "node:http";

export type TrustedLanAgentSource = { nodeId: string; agentId: string; provider: "codex" | "dsh"; sessionId: string; sessionName: string; workspace?: string };
const sources = new WeakMap<IncomingMessage, TrustedLanAgentSource>();
export function setTrustedLanAgentSource(request: IncomingMessage, source: TrustedLanAgentSource): void { sources.set(request, Object.freeze({ ...source })); }
export function getTrustedLanAgentSource(request: IncomingMessage): TrustedLanAgentSource | undefined { return sources.get(request); }
const guards = new WeakMap<IncomingMessage, (body: unknown) => void>();
export function registerLanAgentBodyGuard(request: IncomingMessage, guard: (body: unknown) => void): void { guards.set(request, guard); }
export function hasLanAgentBodyGuard(request: IncomingMessage): boolean { return guards.has(request); }
export function validateLanAgentRequestBody(request: IncomingMessage, body: unknown): void { guards.get(request)?.(body); }

/** Source claims are bound to the authenticated computer and selected registered Agent. */
export function assertLanAgentBodyAuthority(target: string, body: unknown, agent: InstanceAgent | undefined): void {
  if (!agent || !body || typeof body !== "object" || Array.isArray(body)) throw new Error("Remote Agent request identity is unavailable.");
  const value = body as Record<string, unknown>;
  const provider = agent.provider === "codex-desktop" ? "codex" : agent.provider;
  const sessions = new Set([agent.sessionId, ...(agent.managedSessionIds ?? [])].filter(Boolean));
  const session = (id: unknown) => { if (typeof id !== "string" || !sessions.has(id)) throw new Error("Remote Agent source session is not owned by this Agent."); };
  if (value.sourceThreadId !== undefined) session(value.sourceThreadId);
  if (value.decidedByThreadId !== undefined) session(value.decidedByThreadId);
  if (value.worker && typeof value.worker === "object") {
    const worker = value.worker as Record<string, unknown>;
    if (worker.threadId !== undefined) session(worker.threadId);
    if (worker.sessionId !== undefined) session(worker.sessionId);
  }
  if (target === "/api/message-processing/requirements" && value.action === "register_group") throw new Error("Message ingress registration is owned by Manager, not remote Agents.");
  if (value.sender !== undefined) {
    if (!value.sender || typeof value.sender !== "object") throw new Error("Invalid remote Agent sender.");
    session((value.sender as Record<string, unknown>).sessionId);
  }
  if (value.messageSource !== undefined) {
    const source = value.messageSource as Record<string, unknown>;
    if (!source || source.type !== "agent" || source.agentAdapter !== provider) throw new Error("Remote Agent cannot impersonate a system, plan or message adapter source.");
    session(source.sessionId);
    if (value.sourceThreadId !== undefined && value.sourceThreadId !== source.sessionId) throw new Error("Remote Agent source identities do not match.");
  }
  if (target === "/api/agent/send" && value.sender === undefined) throw new Error("Remote Agent sender is required.");
  if (target === "/api/agent/threads" && (value.action === "send" || (value.action === "create" && value.message))) {
    if (value.messageSource === undefined || value.sourceThreadId === undefined) throw new Error("Remote Agent delivery requires its authenticated source session.");
  }
  if (target.endsWith("/context")) session(value.session_id ?? value.sessionId);
}
