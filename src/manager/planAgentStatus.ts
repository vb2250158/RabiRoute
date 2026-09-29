import { openCodexDesktopThread } from "../codexDesktopBridge.js";
import { readCodexThread } from "../codexRuntime.js";
import { listDshSessions, openDshSession, readDshSession } from "../dshSessionBridge.js";
import { openAntigravitySession, readAntigravitySession } from "../antigravitySessionStore.js";
import {
  agentAdapterManifest,
  type PlanAssistantAgentType
} from "../shared/agentAdapterCapabilities.js";
import type { PlanHistoryRecord, PlanItem, PlanSecretaryBinding, PlanTaskBinding } from "../roleKnowledge.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";

export const PLAN_AGENT_STATUS_TIMEOUT_MS = 2_800;
export const PLAN_DSH_AGENT_STATUS_TIMEOUT_MS = 10_000;

export type PlanAgentRole = "task" | "secretary";
export type PlanAgentWorkStatus = "working" | "idle" | "unknown";
export type PlanAgentSessionStatus =
  | "active"
  | "idle"
  | "not_loaded"
  | "unavailable"
  | "archived"
  | "missing"
  | "workspace_mismatch"
  | "unbound"
  | "unknown";

export type PlanAgentBindingStatus = {
  role: PlanAgentRole;
  configured: boolean;
  agentType: PlanAssistantAgentType;
  threadId: string;
  threadTitle: string;
  workspace: string;
  working: boolean;
  agentStatus: PlanAgentWorkStatus;
  sessionStatus: PlanAgentSessionStatus;
  canOpen: boolean;
  checkedAt: string;
  message?: string;
};

export type PlanAgentStatus = {
  planId: string;
  checkedAt: string;
  taskAgent: PlanAgentBindingStatus;
  secretaryAgent?: PlanAgentBindingStatus;
};

type PlanAgentBinding = PlanTaskBinding | PlanSecretaryBinding;

type AgentSessionReadModel = {
  id: string;
  title: string;
  cwd: string;
  archived: boolean;
  status: string;
};

export type PlanAgentStatusService = {
  inspectPlans(plans: PlanItem[]): Promise<PlanAgentStatus[]>;
  openHistoryActor?(record: PlanHistoryRecord): Promise<{ opened: true; agentType: string; threadId: string; threadTitle: string; workspace: string }>;
  openPlanAgent(plan: PlanItem, role: PlanAgentRole): Promise<{
    planId: string;
    role: PlanAgentRole;
    agentType: PlanAssistantAgentType;
    threadId: string;
    threadTitle: string;
    workspace: string;
    opened: true;
  }>;
};

export type PlanAgentStatusDependencies = {
  /** Legacy Codex seam retained for existing callers and tests. */
  readThread?: (threadId: string) => Promise<unknown>;
  /** Legacy Codex seam retained for existing callers and tests. */
  openThread?: (threadId: string) => Promise<void>;
  readCodexThread?: (threadId: string) => Promise<unknown>;
  openCodexThread?: (threadId: string) => Promise<void>;
  readDshSession?: (sessionId: string, baseUrl?: string) => Promise<unknown>;
  listDshSessions?: (baseUrl?: string) => Promise<unknown[]>;
  openDshSession?: (sessionId: string, baseUrl?: string) => Promise<void>;
  readAntigravitySession?: (conversationId: string) => Promise<unknown>;
  openAntigravitySession?: (conversationId: string) => Promise<void>;
  timeoutMs?: number;
  now?: () => Date;
};

class PlanAgentStatusTimeoutError extends Error {
  constructor() {
    super("Plan Agent session status query timed out.");
    this.name = "PlanAgentStatusTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PlanAgentStatusTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Human-readable owner name, taken from the adapter manifest so a newly
 * supported adapter stops being mislabelled as Codex in status messages.
 */
function agentLabel(agentType: PlanAgentBinding["agentType"]): string {
  return agentAdapterManifest(agentType).label;
}

function isMissingSessionError(error: unknown): boolean {
  return /not found|was not found|no rollout found/i.test(errorMessage(error));
}

function normalizeSession(value: unknown): AgentSessionReadModel | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const status = item.status && typeof item.status === "object"
    ? String((item.status as Record<string, unknown>).type || "")
    : "";
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id.trim(),
    title: typeof item.title === "string" ? item.title.trim() : "",
    cwd: typeof item.cwd === "string" ? item.cwd.trim() : "",
    archived: item.archived === true,
    status
  };
}

function emptyBindingStatus(role: PlanAgentRole, checkedAt: string): PlanAgentBindingStatus {
  return {
    role,
    configured: false,
    agentType: "codex",
    threadId: "",
    threadTitle: "",
    workspace: "",
    working: false,
    agentStatus: "unknown",
    sessionStatus: "unbound",
    canOpen: false,
    checkedAt
  };
}

function bindingIdentity(
  role: PlanAgentRole,
  binding: PlanAgentBinding,
  checkedAt: string
): Pick<PlanAgentBindingStatus, "role" | "configured" | "agentType" | "threadId" | "threadTitle" | "workspace" | "checkedAt"> {
  return {
    role,
    configured: true,
    agentType: binding.agentType,
    threadId: String(binding.sessionId || "").trim(),
    threadTitle: String(binding.sessionTitle || "").trim(),
    workspace: String(binding.workspace || "").trim(),
    checkedAt
  };
}

function workspaceMatches(bindingWorkspace: string, sessionWorkspace: string): boolean {
  if (!bindingWorkspace || !sessionWorkspace) return true;
  return normalizePathForComparison(bindingWorkspace) === normalizePathForComparison(sessionWorkspace);
}

function statusFromSession(
  role: PlanAgentRole,
  binding: PlanAgentBinding,
  session: AgentSessionReadModel,
  checkedAt: string
): PlanAgentBindingStatus {
  const identity = bindingIdentity(role, binding, checkedAt);
  const threadTitle = session.title || identity.threadTitle;
  const workspace = identity.workspace || session.cwd;
  const label = agentLabel(binding.agentType);
  // Workspace drift matters for every adapter that reports a cwd, not just DSH:
  // a bound plan step must not act on a session sitting in another project.
  if (!workspaceMatches(identity.workspace, session.cwd)) {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "unknown",
      sessionStatus: "workspace_mismatch",
      canOpen: false,
      message: `Bound workspace does not match the ${label} session: ${identity.workspace} != ${session.cwd}`
    };
  }
  if (session.archived) {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "idle",
      sessionStatus: "archived",
      canOpen: false
    };
  }
  if (session.status === "active") {
    return { ...identity, threadTitle, workspace, working: true, agentStatus: "working", sessionStatus: "active", canOpen: true };
  }
  if (session.status === "idle") {
    return { ...identity, threadTitle, workspace, working: false, agentStatus: "idle", sessionStatus: "idle", canOpen: true };
  }
  if (session.status === "notLoaded") {
    return { ...identity, threadTitle, workspace, working: false, agentStatus: "idle", sessionStatus: "not_loaded", canOpen: true };
  }
  if (session.status === "unavailable") {
    return { ...identity, threadTitle, workspace, working: false, agentStatus: "unknown", sessionStatus: "unavailable", canOpen: true };
  }
  return {
    ...identity,
    threadTitle,
    workspace,
    working: false,
    agentStatus: "unknown",
    sessionStatus: "unknown",
    canOpen: true,
    message: `${label} session status is unknown.`
  };
}

function failedBindingStatus(
  role: PlanAgentRole,
  binding: PlanAgentBinding,
  checkedAt: string,
  error: unknown
): PlanAgentBindingStatus {
  const identity = bindingIdentity(role, binding, checkedAt);
  const missing = isMissingSessionError(error);
  const label = agentLabel(binding.agentType);
  return {
    ...identity,
    working: false,
    agentStatus: "unknown",
    sessionStatus: missing ? "missing" : "unknown",
    canOpen: false,
    message: missing ? `${label} session was not found.` : errorMessage(error)
  };
}

function bindingKey(binding: PlanAgentBinding): string {
  // `baseUrl` only takes part for adapters that address their host over HTTP.
  return [
    binding.agentType,
    String(binding.sessionId || "").trim(),
    normalizePathForComparison(String(binding.workspace || "")),
    binding.agentType === "dsh" ? String(binding.baseUrl || "").trim().toLowerCase() : ""
  ].join("\u001f");
}

export function createPlanAgentStatusService(
  dependencies: PlanAgentStatusDependencies = {}
): PlanAgentStatusService {
  const readCodex = dependencies.readCodexThread ?? dependencies.readThread ?? readCodexThread;
  const openCodex = dependencies.openCodexThread ?? dependencies.openThread ?? openCodexDesktopThread;
  const readDsh = dependencies.readDshSession ?? readDshSession;
  const listDsh = dependencies.listDshSessions ?? (async (baseUrl?: string) => listDshSessions({ baseUrl, limit: Number.MAX_SAFE_INTEGER }));
  const openDsh = dependencies.openDshSession ?? openDshSession;
  const readAntigravity = dependencies.readAntigravitySession
    ?? (async (conversationId: string) => readAntigravitySession(conversationId));
  const openAntigravity = dependencies.openAntigravitySession
    ?? (async (conversationId: string) => { openAntigravitySession(conversationId); });
  const timeoutMs = (binding: PlanAgentBinding) => Math.max(1, dependencies.timeoutMs ?? (binding.agentType === "dsh" ? PLAN_DSH_AGENT_STATUS_TIMEOUT_MS : PLAN_AGENT_STATUS_TIMEOUT_MS));
  const now = dependencies.now ?? (() => new Date());

  // Dispatch on the bound adapter, which is preserved verbatim on the binding.
  // An unrecognized adapter is a hard error rather than a Codex fallback: reading
  // the wrong owner's session would report a false status.
  const readBinding = (binding: PlanAgentBinding): Promise<unknown> => {
    if (binding.agentType === "dsh") return readDsh(binding.sessionId, binding.baseUrl);
    if (binding.agentType === "antigravity") return readAntigravity(binding.sessionId);
    if (binding.agentType === "codex") return readCodex(binding.sessionId);
    return Promise.reject(new Error(`Plan binding names an unsupported agentType: ${binding.agentType}`));
  };
  const openBinding = (binding: PlanAgentBinding, sessionId: string): Promise<void> => {
    if (binding.agentType === "dsh") return openDsh(sessionId, binding.baseUrl);
    if (binding.agentType === "antigravity") return openAntigravity(sessionId);
    if (binding.agentType === "codex") return openCodex(sessionId);
    return Promise.reject(new Error(`Plan binding names an unsupported agentType: ${binding.agentType}`));
  };

  async function inspectBinding(
    role: PlanAgentRole,
    binding: PlanAgentBinding,
    checkedAt: string,
    read: () => Promise<unknown> = () => readBinding(binding)
  ): Promise<PlanAgentBindingStatus> {
    try {
      const value = await withTimeout(read(), timeoutMs(binding));
      const session = normalizeSession(value);
      if (!session) throw new Error(`${agentLabel(binding.agentType)} session status response is invalid.`);
      return statusFromSession(role, binding, session, checkedAt);
    } catch (error) {
      return failedBindingStatus(role, binding, checkedAt, error);
    }
  }

  return {
    async openHistoryActor(record) {
      const actor = record.actor;
      if (actor?.kind !== "agent" || !actor.agentType || !actor.sessionId) throw new Error("History has no Agent session identity.");
      if (actor.agentType !== "codex" && actor.agentType !== "dsh" && actor.agentType !== "antigravity") {
        throw new Error(`Opening history sessions is not supported for ${actor.agentType}.`);
      }
      const binding: PlanAgentBinding = {
        agentType: actor.agentType,
        sessionId: actor.sessionId,
        sessionTitle: actor.displayName || actor.sessionId,
        workspace: actor.workspace || "",
        ...(actor.baseUrl ? { baseUrl: actor.baseUrl } : {})
      };
      const session = normalizeSession(await withTimeout(readBinding(binding), timeoutMs(binding)));
      if (!session || session.id !== actor.sessionId) throw new Error("Original Agent session was not found.");
      if (session.archived) throw new Error("Original Agent session is archived.");
      await openBinding(binding, actor.sessionId);
      return { opened: true, agentType: actor.agentType, threadId: actor.sessionId, threadTitle: session.title || binding.sessionTitle || actor.sessionId, workspace: session.cwd };
    },
    async inspectPlans(plans) {
      const checkedAt = now().toISOString();
      const shared = new Map<string, Promise<PlanAgentBindingStatus>>();
      const dshCatalogs = new Map<string, Promise<Map<string, unknown>>>();
      const readDshFromCatalog = (binding: PlanAgentBinding): Promise<unknown> => {
        const baseUrl = String(binding.baseUrl || "");
        let catalog = dshCatalogs.get(baseUrl);
        if (!catalog) {
          catalog = listDsh(binding.baseUrl).then(rows => new Map(rows.flatMap(row => {
            const session = normalizeSession(row);
            return session ? [[session.id, row] as const] : [];
          })));
          dshCatalogs.set(baseUrl, catalog);
        }
        return catalog.then(rows => {
          const row = rows.get(binding.sessionId);
          if (!row) throw new Error(`DSH session was not found: ${binding.sessionId}`);
          return row;
        });
      };
      const inspectShared = (role: PlanAgentRole, binding: PlanAgentBinding): Promise<PlanAgentBindingStatus> => {
        const key = bindingKey(binding);
        const existing = shared.get(key);
        if (existing) return existing.then((status) => ({ ...status, role }));
        const read = binding.agentType === "dsh" && (!dependencies.readDshSession || dependencies.listDshSessions)
          ? () => readDshFromCatalog(binding)
          : () => readBinding(binding);
        const request = inspectBinding(role, binding, checkedAt, read);
        shared.set(key, request);
        return request;
      };
      return Promise.all(plans.map(async (plan) => ({
        planId: plan.id,
        checkedAt,
        taskAgent: plan.taskBinding ? await inspectShared("task", plan.taskBinding) : emptyBindingStatus("task", checkedAt),
        ...(plan.secretaryBinding ? { secretaryAgent: await inspectShared("secretary", plan.secretaryBinding) } : {})
      })));
    },

    async openPlanAgent(plan, role) {
      const binding = role === "secretary" ? plan.secretaryBinding : plan.taskBinding;
      if (!binding) throw new Error(role === "secretary" ? "Plan secretary Agent is not configured." : "Plan task Agent is not configured.");
      const value = await withTimeout(readBinding(binding), timeoutMs(binding));
      const session = normalizeSession(value);
      const label = agentLabel(binding.agentType);
      if (!session) throw new Error(`${label} session status response is invalid.`);
      if (!workspaceMatches(String(binding.workspace || "").trim(), session.cwd)) {
        throw new Error(`Bound workspace does not match the ${label} session: ${binding.workspace || ""} != ${session.cwd}`);
      }
      if (session.archived) throw new Error(`${label} session is archived; restore it before opening from the plan.`);
      await openBinding(binding, session.id);
      return {
        planId: plan.id,
        role,
        agentType: binding.agentType,
        threadId: session.id,
        threadTitle: session.title || String(binding.sessionTitle || "").trim(),
        workspace: String(binding.workspace || "").trim() || session.cwd,
        opened: true
      };
    }
  };
}

export const planAgentStatusService = createPlanAgentStatusService();
