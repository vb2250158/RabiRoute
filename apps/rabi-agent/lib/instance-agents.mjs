import { randomUUID } from "node:crypto";
import { resolveTaskWorkspace } from "./cwd-policy.mjs";
import { normalizeDshBinding } from "./dsh.mjs";

const isProfileRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Optional execution backend settings contain no saved sessions or API grants. */
export function instanceAgents(config) {
  return Array.isArray(config.agents) ? config.agents.filter(isProfileRecord).map(({ sessionId, managedSessionIds, enabled, ...profile }) => ({ ...profile, ...(profile.dsh ? { dsh: { baseUrl: profile.dsh.baseUrl } } : {}) })) : [];
}

export function agentCatalog(config) {
  return instanceAgents(config).map(({ agentId, name, provider, enabled, workspace, model, reasoningEffort, dsh }) => ({ agentId, name, provider, enabled: true, workspace, model, reasoningEffort, dshBaseUrl: dsh?.baseUrl }));
}

export function configureInstanceAgent(config, input) {
  if (!input || typeof input !== "object") throw new Error("Agent configuration is required.");
  const agents = instanceAgents(config);
  const agentId = input.agentId || randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(agentId)) throw new Error("Invalid Agent identity.");
  const current = agents.find(agent => agent.agentId === agentId);
  const provider = input.provider || current?.provider;
  if (!["codex-desktop", "dsh"].includes(provider)) throw new Error("Unsupported Agent provider.");
  if (current && current.provider !== provider) throw new Error("Create a new Agent when changing providers.");
  const workspace = resolveTaskWorkspace(input.workspace || current?.workspace, config);
  if (input.sessionId !== undefined || input.managedSessionIds !== undefined) throw new Error("Saved session bindings were removed; pass the full session ID in each request.");
  const agent = {
    agentId, provider, workspace, name: String(input.name || current?.name || "Agent").slice(0, 160),
    model: String(input.model ?? current?.model ?? "").trim() || undefined,
    reasoningEffort: String(input.reasoningEffort ?? current?.reasoningEffort ?? "medium").trim(),
    dsh: provider === "dsh" ? { baseUrl: normalizeDshBinding({ baseUrl: input.dshBaseUrl || current?.dsh?.baseUrl || config.dsh?.baseUrl, sessionId: "configuration" }).baseUrl } : undefined
  };

  if (!current && agents.length >= 128) throw new Error("This instance already has 128 Agents.");
  // Preserve unrecognized raw entries when editing an unrelated healthy backend.
  const rawAgents = Array.isArray(config.agents) ? config.agents : [];
  return { ...config, agents: current ? rawAgents.map(item => isProfileRecord(item) && item.agentId === agentId ? agent : item) : [...rawAgents, agent] };
}

export function resolveInstanceAgent(config, task) {
  const agents = instanceAgents(config);
  if (typeof task.targetAgent !== "string" || !task.targetAgent.trim()) throw new Error("Explicit targetAgent is required.");
  if (typeof task.threadId !== "string" || !task.threadId || task.threadId !== task.threadId.trim()
    || task.threadId.length > 4096 || /[\0\r\n\u2028\u2029]/u.test(task.threadId)) throw new Error("Explicit full threadId is required; query the Agent thread list.");
  if (!["codex-desktop", "dsh"].includes(task.targetAgent)) throw new Error("This computer does not implement the requested Agent type.");
  const matches = agents.filter(agent => agent.provider === task.targetAgent && (!task.agentId || agent.agentId === task.agentId));
  if (matches.length > 1) throw new Error("Multiple backend configurations exist; explicitly select the backend connection.");
  const agent = matches[0] || { agentId: task.targetAgent, provider: task.targetAgent, workspace: config.defaultWorkspace, dsh: config.dsh };
  return agent;
}

export function withoutSessionBindings(config) {
  const next = structuredClone(config);
  const invalidRows = Array.isArray(config.agents) ? config.agents.flatMap((row, index) => isProfileRecord(row) ? [] : [index]) : [];
  if (invalidRows.length) {
    console.warn(`Rabi Agent configuration: ignored invalid optional backend entries at agents[${invalidRows.join(", ")}]; original configuration is retained. Repair those entries in the configuration file.`);
    // readConfig persists session retirement only when this value changes. Keep
    // the original raw document until it can be migrated without losing rows;
    // execution/catalog projections still remove saved sessions below.
    return next;
  }
  delete next.agentType;
  next.agents = instanceAgents(config);
  if (next.dsh) delete next.dsh.sessionId;
  if (next.codexDesktop) delete next.codexDesktop.threadId;
  return next;
}
