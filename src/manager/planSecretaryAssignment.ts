import { createHash } from "node:crypto";
import type { PlanItem, PlanSecretaryBinding } from "../roleKnowledge.js";
import { filterCodexPlanAssistantSessionsForTarget, planAssistantSessionAgentAdapter, type CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import type { PlanAssistantAgentType } from "../shared/agentAdapterCapabilities.js";

export type PlanSecretaryTarget = {
  agentTargetId?: string;
  agentAdapter: PlanAssistantAgentType;
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  model?: string;
};

export type PlanSecretaryAssignment = {
  target: PlanSecretaryTarget;
  binding: PlanSecretaryBinding & { agentTargetId?: string };
  changed: boolean;
};

function sameBindingIdentity(binding: (PlanSecretaryBinding & { agentTargetId?: string }) | undefined, session: CodexPlanAssistantSession): boolean {
  if (!binding) return false;
  const targetId = session.agentTargetId?.trim() || undefined;
  // Preserve the historical DSH type repair only in the unassigned legacy pool.
  const legacyDshTypeRepair = !targetId && !binding.agentTargetId?.trim()
    && binding.agentType === "codex" && session.threadId.startsWith("session-")
    && planAssistantSessionAgentAdapter(session) === "dsh";
  return (binding.agentTargetId?.trim() || undefined) === targetId
    && (binding.agentType === planAssistantSessionAgentAdapter(session) || legacyDshTypeRepair)
    && binding.sessionId === session.threadId
    && sameCodexWorkspace(binding.workspace, session.workspace);
}

function orderedSessions(sessions: readonly CodexPlanAssistantSession[] | undefined): CodexPlanAssistantSession[] {
  return [...(sessions || [])]
    .filter((session) => session.threadId.trim() && session.threadName.trim() && session.workspace.trim())
    .sort((left, right) => left.index - right.index || left.threadId.localeCompare(right.threadId));
}

function selectedIndex(planId: string, count: number): number {
  return createHash("sha256").update(planId).digest().readUInt32BE(0) % count;
}

/**
 * Clear only persisted secretary bindings that cannot belong to the current
 * selected target's Primary Persona workspace. Other targets are untouched.
 * An omitted target selects only legacy unassigned bindings. Existing bindings
 * in the same workspace remain intact when the secretary pool is disabled.
 */
export function reconcilePlanSecretaryBindingsForWorkspace(
  plans: readonly PlanItem[],
  primaryWorkspace: string | undefined,
  clearBinding: (planId: string) => void,
  agentTargetId?: string
): string[] {
  if (!primaryWorkspace?.trim()) return [];
  const clearedPlanIds: string[] = [];
  for (const plan of plans) {
    const binding = plan.secretaryBinding as (PlanSecretaryBinding & { agentTargetId?: string }) | undefined;
    if (!binding || (binding.agentTargetId?.trim() || undefined) !== (agentTargetId?.trim() || undefined)
      || sameCodexWorkspace(binding.workspace, primaryWorkspace)) continue;
    clearBinding(plan.id);
    clearedPlanIds.push(plan.id);
  }
  return clearedPlanIds;
}

export function resolvePlanSecretaryAssignment(
  plan: PlanItem,
  sessions: readonly CodexPlanAssistantSession[] | undefined,
  assignedAt = new Date().toISOString(),
  agentTargetId?: string
): PlanSecretaryAssignment | undefined {
  // No target means legacy unassigned only; configuration migration owns attribution.
  const candidates = orderedSessions(filterCodexPlanAssistantSessionsForTarget(sessions, agentTargetId));
  if (!candidates.length) return undefined;
  const existing = candidates.find((session) => sameBindingIdentity(plan.secretaryBinding, session));
  const selected = existing || candidates[selectedIndex(plan.id, candidates.length)]!;
  const selectedAgentAdapter = planAssistantSessionAgentAdapter(selected);
  return {
    target: {
      ...(selected.agentTargetId ? { agentTargetId: selected.agentTargetId } : {}),
      agentAdapter: selectedAgentAdapter,
      threadId: selected.threadId,
      threadName: selected.threadName,
      workspace: selected.workspace,
      index: selected.index
    },
    binding: {
      ...(selected.agentTargetId ? { agentTargetId: selected.agentTargetId } : {}),
      agentType: selectedAgentAdapter,
      sessionId: selected.threadId,
      sessionTitle: selected.threadName,
      workspace: selected.workspace,
      assignedAt: existing ? plan.secretaryBinding?.assignedAt : assignedAt
    },
    changed: !existing
      || plan.secretaryBinding?.agentType !== selectedAgentAdapter
      || plan.secretaryBinding?.sessionTitle !== selected.threadName
      || plan.secretaryBinding?.assignedAt == null
  };
}
