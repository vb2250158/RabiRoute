import { randomUUID } from "node:crypto";
import { resolveTaskWorkspace } from "./cwd-policy.mjs";
import { normalizeDshBinding } from "./dsh.mjs";

/** The executing computer owns task settings; enrolled Agent enablement belongs to Manager. */
export function instanceAgents(config) {
  return Array.isArray(config.agents) ? config.agents : [];
}

export function agentCatalog(config) {
  // Legacy enabled is exported only for Manager's first-registration import.
  // Retire that import when pre-Manager connector configuration snapshots are no longer supported.
  return instanceAgents(config).map(({ agentId, name, provider, enabled, workspace, sessionId, managedSessionIds, model, reasoningEffort, dsh }) => ({ agentId, name, provider, enabled: enabled !== false, workspace, sessionId, managedSessionIds, model, reasoningEffort, dshBaseUrl: dsh?.baseUrl }));
}

export function configureInstanceAgent(config, input) {
  if (!input || typeof input !== "object") throw new Error("Agent configuration is required.");
  if (config.nodeCredential && input.enabled !== undefined) throw new Error("Change enrolled Agent enablement through the Manager authorization endpoint.");
  const agents = instanceAgents(config);
  const agentId = input.agentId || randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(agentId)) throw new Error("Invalid Agent identity.");
  const current = agents.find(agent => agent.agentId === agentId);
  const provider = input.provider || current?.provider;
  if (!["codex-desktop", "dsh"].includes(provider)) throw new Error("Unsupported Agent provider.");
  if (current && current.provider !== provider) throw new Error("Create a new Agent when changing providers.");
  const workspace = resolveTaskWorkspace(input.workspace || current?.workspace, config);
  const sessionId = String(input.sessionId ?? current?.sessionId ?? "").trim();
  if (!sessionId || sessionId.length > 192) throw new Error("Select an existing task owner before saving this Agent.");
  if (agents.some(agent => agent.agentId !== agentId && agent.provider === provider && (agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId)))) throw new Error("This task already belongs to another Agent in this instance.");
  const agent = {
    agentId, provider, workspace, sessionId, name: String(input.name || current?.name || "Agent").slice(0, 160),
    managedSessionIds: current?.sessionId === sessionId ? current?.managedSessionIds : undefined,
    ...(!config.nodeCredential ? { enabled: input.enabled ?? current?.enabled ?? true } : {}),
    model: String(input.model ?? current?.model ?? "").trim() || undefined,
    reasoningEffort: String(input.reasoningEffort ?? current?.reasoningEffort ?? "medium").trim(),
    dsh: provider === "dsh" ? normalizeDshBinding({ baseUrl: input.dshBaseUrl || current?.dsh?.baseUrl || config.dsh?.baseUrl, sessionId }) : undefined
  };
  if (!config.nodeCredential && typeof agent.enabled !== "boolean") throw new Error("Agent enabled must be a boolean.");
  if (!current && agents.length >= 128) throw new Error("This instance already has 128 Agents.");
  return { ...config, agents: current ? agents.map(item => item.agentId === agentId ? agent : item) : [...agents, agent] };
}

/** Only tasks resolved on this computer may inherit their primary Agent's Hook context. */
export function registerManagedSession(config, agentId, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 192) return config;
  const agents = instanceAgents(config);
  const owner = agents.find(agent => agent.agentId === agentId);
  if (!owner) throw new Error("The primary instance Agent no longer exists.");
  if (agents.some(agent => agent.agentId !== agentId && (agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId)))) throw new Error("The task belongs to another instance Agent.");
  if (owner.sessionId === sessionId || owner.managedSessionIds?.includes(sessionId)) return config;
  if ((owner.managedSessionIds?.length || 0) >= 512) throw new Error("This Agent already owns 512 managed tasks.");
  return { ...config, agents: agents.map(agent => agent.agentId === agentId ? { ...agent, managedSessionIds: [...agent.managedSessionIds || [], sessionId] } : agent) };
}

export function resolveInstanceAgent(config, task) {
  const agents = instanceAgents(config);
  if (typeof task.agentId !== "string" || !task.agentId.trim()) throw new Error("Explicit agentId is required; query the instance Agent catalog.");
  if (typeof task.targetAgent !== "string" || !task.targetAgent.trim()) throw new Error("Explicit targetAgent is required.");
  if (typeof task.threadId !== "string" || !task.threadId || task.threadId !== task.threadId.trim()
    || task.threadId.length > 4096 || /[\0\r\n\u2028\u2029]/u.test(task.threadId)) throw new Error("Explicit full threadId is required; query the Agent thread list.");
  const agent = agents.find(agent => agent.agentId === task.agentId);
  // Enrolled execution rechecks Manager authority immediately before the host turn.
  if (!agent || (!config.nodeCredential && agent.enabled === false)) throw new Error("The requested instance Agent is missing or disabled.");
  if (task.targetAgent !== agent.provider) throw new Error("The requested provider does not match the bound Agent.");
  return agent;
}
