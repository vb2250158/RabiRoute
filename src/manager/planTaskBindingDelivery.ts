import type { PlanItem, PlanTaskBinding } from "../roleKnowledge.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import type { PlanAssistantAgentType } from "../shared/agentAdapterCapabilities.js";

export type PlanTaskDeliveryTarget = {
  agentAdapter: PlanAssistantAgentType;
  threadId: string;
  title: string;
  cwd: string;
  createIfMissing: true;
};

export type ResolvedPlanTask = {
  id: string;
  title?: string;
  cwd?: string;
};

export function planTaskDeliveryTarget(plan: PlanItem): PlanTaskDeliveryTarget | null {
  const binding = plan.taskBinding;
  const threadId = binding?.sessionId.trim() || "";
  const cwd = binding?.workspace?.trim() || "";
  if (!binding || !threadId || !cwd) return null;
  return {
    // Carry the bound owner through unchanged. The old `=== "dsh" ? "dsh" :
    // "codex"` form silently relabelled every other adapter as Codex, which
    // would deliver a plan step into a Codex task that has nothing to do with it.
    agentAdapter: binding.agentType,
    threadId,
    title: binding?.sessionTitle?.trim() || plan.title,
    cwd,
    createIfMissing: true
  };
}

export function replacementPlanTaskBinding(
  plan: PlanItem,
  resolved: ResolvedPlanTask
): PlanTaskBinding | null {
  const binding = plan.taskBinding;
  const sessionId = resolved.id.trim();
  if (!binding || !sessionId || sessionId === binding.sessionId) return null;
  const workspace = resolved.cwd?.trim() || binding.workspace?.trim() || "";
  if (!workspace) throw new Error("Replacement Agent session workspace is unavailable.");
  if (binding.workspace && !sameCodexWorkspace(binding.workspace, workspace)) {
    throw new Error(`Replacement Agent session belongs to another workspace: ${workspace}`);
  }
  return {
    ...binding,
    sessionId,
    sessionTitle: resolved.title?.trim() || binding.sessionTitle || plan.title,
    ...(binding.modelSnapshot ? { modelSnapshot: binding.modelSnapshot } : {}),
    workspace
  };
}