import { openCodexDesktopThread } from "../codexDesktopBridge.js";
import { readCodexThread } from "../codexRuntime.js";
import { openDshSession, readDshSession } from "../dshSessionBridge.js";
import type { PlanItem, PlanSecretaryBinding, PlanTaskBinding } from "../roleKnowledge.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";

export const PLAN_AGENT_STATUS_TIMEOUT_MS = 2_800;

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
  agentType: "codex" | "dsh";
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
  openPlanAgent(plan: PlanItem, role: PlanAgentRole): Promise<{
    planId: string;
    role: PlanAgentRole;
    agentType: "codex" | "dsh";
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
  openDshSession?: (sessionId: string, baseUrl?: string) => Promise<void>;
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

function agentLabel(agentType: PlanAgentBinding["agentType"]): string {
  return agentType === "dsh" ? "DSH" : "Codex Desktop";
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
  const workspace = session.cwd || identity.workspace;
  const label = agentLabel(binding.agentType);
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
  const openDsh = dependencies.openDshSession ?? openDshSession;
  const timeoutMs = Math.max(1, dependencies.timeoutMs ?? PLAN_AGENT_STATUS_TIMEOUT_MS);
  const now = dependencies.now ?? (() => new Date());

  const readBinding = (binding: PlanAgentBinding): Promise<unknown> => binding.agentType === "dsh"
    ? readDsh(binding.sessionId, binding.baseUrl)
    : readCodex(binding.sessionId);
  const openBinding = (binding: PlanAgentBinding, sessionId: string): Promise<void> => binding.agentType === "dsh"
    ? openDsh(sessionId, binding.baseUrl)
    : openCodex(sessionId);

  async function inspectBinding(
    role: PlanAgentRole,
    binding: PlanAgentBinding,
    checkedAt: string
  ): Promise<PlanAgentBindingStatus> {
    try {
      const value = await withTimeout(readBinding(binding), timeoutMs);
      const session = normalizeSession(value);
      if (!session) throw new Error(`${agentLabel(binding.agentType)} session status response is invalid.`);
      return statusFromSession(role, binding, session, checkedAt);
    } catch (error) {
      return failedBindingStatus(role, binding, checkedAt, error);
    }
  }

  return {
    async inspectPlans(plans) {
      const checkedAt = now().toISOString();
      const shared = new Map<string, Promise<PlanAgentBindingStatus>>();
      const inspectShared = (role: PlanAgentRole, binding: PlanAgentBinding): Promise<PlanAgentBindingStatus> => {
        const key = bindingKey(binding);
        const existing = shared.get(key);
        if (existing) return existing.then((status) => ({ ...status, role }));
        const request = inspectBinding(role, binding, checkedAt);
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
      const value = await withTimeout(readBinding(binding), timeoutMs);
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
        workspace: session.cwd || String(binding.workspace || "").trim(),
        opened: true
      };
    }
  };
}

export const planAgentStatusService = createPlanAgentStatusService();
