import { createHash } from "node:crypto";
import type { PlanItem, PlanSecretaryBinding } from "../roleKnowledge.js";
import { planAssistantSessionAgentAdapter, type CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";

export type PlanSecretaryTarget = {
  agentAdapter: "codex" | "dsh";
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  model?: string;
};

export type PlanSecretaryAssignment = {
  target: PlanSecretaryTarget;
  binding: PlanSecretaryBinding;
  changed: boolean;
};

function sameBindingIdentity(binding: PlanSecretaryBinding | undefined, session: CodexPlanAssistantSession): boolean {
  return Boolean(binding
    && binding.sessionId === session.threadId
    && sameCodexWorkspace(binding.workspace, session.workspace));
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
 * Primary Persona workspace. Existing bindings in the same workspace remain
 * intact so temporarily disabling the secretary pool does not lose history.
 */
export function reconcilePlanSecretaryBindingsForWorkspace(
  plans: readonly PlanItem[],
  primaryWorkspace: string | undefined,
  clearBinding: (planId: string) => void
): string[] {
  if (!primaryWorkspace?.trim()) return [];
  const clearedPlanIds: string[] = [];
  for (const plan of plans) {
    const binding = plan.secretaryBinding;
    if (!binding || sameCodexWorkspace(binding.workspace, primaryWorkspace)) continue;
    clearBinding(plan.id);
    clearedPlanIds.push(plan.id);
  }
  return clearedPlanIds;
}

export function resolvePlanSecretaryAssignment(
  plan: PlanItem,
  sessions: readonly CodexPlanAssistantSession[] | undefined,
  assignedAt = new Date().toISOString()
): PlanSecretaryAssignment | undefined {
  const candidates = orderedSessions(sessions);
  if (!candidates.length) return undefined;
  const existing = candidates.find((session) => sameBindingIdentity(plan.secretaryBinding, session));
  const selected = existing || candidates[selectedIndex(plan.id, candidates.length)]!;
  const selectedAgentAdapter = planAssistantSessionAgentAdapter(selected);
  return {
    target: {
      agentAdapter: selectedAgentAdapter,
      threadId: selected.threadId,
      threadName: selected.threadName,
      workspace: selected.workspace,
      index: selected.index
    },
    binding: {
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
