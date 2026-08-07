import { openCodexDesktopThread } from "../codexDesktopBridge.js";
import { readCodexThread } from "../codexRuntime.js";
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
  agentType: "codex";
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

type CodexThreadReadModel = {
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
    threadId: string;
    threadTitle: string;
    workspace: string;
    opened: true;
  }>;
};

export type PlanAgentStatusDependencies = {
  readThread?: (threadId: string) => Promise<unknown>;
  openThread?: (threadId: string) => Promise<void>;
  timeoutMs?: number;
  now?: () => Date;
};

class PlanAgentStatusTimeoutError extends Error {
  constructor() {
    super("Codex task status query timed out.");
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

function isMissingThreadError(error: unknown): boolean {
  return /not found|was not found|no rollout found/i.test(errorMessage(error));
}

function normalizeThread(value: unknown): CodexThreadReadModel | null {
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
    agentType: "codex",
    threadId: String(binding.sessionId || "").trim(),
    threadTitle: String(binding.sessionTitle || "").trim(),
    workspace: String(binding.workspace || "").trim(),
    checkedAt
  };
}

function workspaceMatches(bindingWorkspace: string, threadWorkspace: string): boolean {
  if (!bindingWorkspace || !threadWorkspace) return true;
  return normalizePathForComparison(bindingWorkspace) === normalizePathForComparison(threadWorkspace);
}

function statusFromThread(
  role: PlanAgentRole,
  binding: PlanAgentBinding,
  thread: CodexThreadReadModel,
  checkedAt: string
): PlanAgentBindingStatus {
  const identity = bindingIdentity(role, binding, checkedAt);
  const threadTitle = thread.title || identity.threadTitle;
  const workspace = thread.cwd || identity.workspace;
  if (!workspaceMatches(identity.workspace, thread.cwd)) {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "unknown",
      sessionStatus: "workspace_mismatch",
      canOpen: false,
      message: `Bound workspace does not match the Codex task: ${identity.workspace} != ${thread.cwd}`
    };
  }
  if (thread.archived) {
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
  if (thread.status === "active") {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: true,
      agentStatus: "working",
      sessionStatus: "active",
      canOpen: true
    };
  }
  if (thread.status === "idle") {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "idle",
      sessionStatus: "idle",
      canOpen: true
    };
  }
  if (thread.status === "notLoaded") {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "idle",
      sessionStatus: "not_loaded",
      canOpen: true
    };
  }
  if (thread.status === "unavailable") {
    return {
      ...identity,
      threadTitle,
      workspace,
      working: false,
      agentStatus: "unknown",
      sessionStatus: "unavailable",
      canOpen: true
    };
  }
  return {
    ...identity,
    threadTitle,
    workspace,
    working: false,
    agentStatus: "unknown",
    sessionStatus: "unknown",
    canOpen: true,
    message: "Codex task status is unknown."
  };
}

function failedBindingStatus(
  role: PlanAgentRole,
  binding: PlanAgentBinding,
  checkedAt: string,
  error: unknown
): PlanAgentBindingStatus {
  const identity = bindingIdentity(role, binding, checkedAt);
  const missing = isMissingThreadError(error);
  return {
    ...identity,
    working: false,
    agentStatus: "unknown",
    sessionStatus: missing ? "missing" : "unknown",
    canOpen: false,
    message: missing ? "Codex Desktop task was not found." : errorMessage(error)
  };
}

function bindingKey(binding: PlanAgentBinding): string {
  return `${String(binding.sessionId || "").trim()}\u001f${normalizePathForComparison(String(binding.workspace || ""))}`;
}

export function createPlanAgentStatusService(
  dependencies: PlanAgentStatusDependencies = {}
): PlanAgentStatusService {
  const readThread = dependencies.readThread ?? readCodexThread;
  const openThread = dependencies.openThread ?? openCodexDesktopThread;
  const timeoutMs = Math.max(1, dependencies.timeoutMs ?? PLAN_AGENT_STATUS_TIMEOUT_MS);
  const now = dependencies.now ?? (() => new Date());

  async function inspectBinding(
    role: PlanAgentRole,
    binding: PlanAgentBinding,
    checkedAt: string
  ): Promise<PlanAgentBindingStatus> {
    try {
      const value = await withTimeout(readThread(binding.sessionId), timeoutMs);
      const thread = normalizeThread(value);
      if (!thread) throw new Error("Codex task status response is invalid.");
      return statusFromThread(role, binding, thread, checkedAt);
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
        if (existing) {
          return existing.then((status) => ({ ...status, role }));
        }
        const request = inspectBinding(role, binding, checkedAt);
        shared.set(key, request);
        return request;
      };
      return Promise.all(plans.map(async (plan) => ({
        planId: plan.id,
        checkedAt,
        taskAgent: plan.taskBinding
          ? await inspectShared("task", plan.taskBinding)
          : emptyBindingStatus("task", checkedAt),
        ...(plan.secretaryBinding
          ? { secretaryAgent: await inspectShared("secretary", plan.secretaryBinding) }
          : {})
      })));
    },

    async openPlanAgent(plan, role) {
      const binding = role === "secretary" ? plan.secretaryBinding : plan.taskBinding;
      if (!binding) throw new Error(role === "secretary" ? "Plan secretary Agent is not configured." : "Plan task Agent is not configured.");
      const value = await withTimeout(readThread(binding.sessionId), timeoutMs);
      const thread = normalizeThread(value);
      if (!thread) throw new Error("Codex task status response is invalid.");
      if (!workspaceMatches(String(binding.workspace || "").trim(), thread.cwd)) {
        throw new Error(`Bound workspace does not match the Codex task: ${binding.workspace || ""} != ${thread.cwd}`);
      }
      if (thread.archived) throw new Error("Codex Desktop task is archived; restore it before opening from the plan.");
      await openThread(thread.id);
      return {
        planId: plan.id,
        role,
        threadId: thread.id,
        threadTitle: thread.title || String(binding.sessionTitle || "").trim(),
        workspace: thread.cwd || String(binding.workspace || "").trim(),
        opened: true
      };
    }
  };
}

export const planAgentStatusService = createPlanAgentStatusService();
