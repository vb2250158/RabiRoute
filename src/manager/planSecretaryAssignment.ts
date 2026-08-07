import { createHash } from "node:crypto";
import path from "node:path";
import type { PlanItem, PlanSecretaryBinding } from "../roleKnowledge.js";
import type { CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";

export type PlanSecretaryTarget = {
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

function normalizedWorkspace(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function sameBinding(binding: PlanSecretaryBinding | undefined, session: CodexPlanAssistantSession): boolean {
  return Boolean(binding
    && binding.sessionId === session.threadId
    && normalizedWorkspace(binding.workspace) === normalizedWorkspace(session.workspace));
}

function orderedSessions(sessions: readonly CodexPlanAssistantSession[] | undefined): CodexPlanAssistantSession[] {
  return [...(sessions || [])]
    .filter((session) => session.threadId.trim() && session.threadName.trim() && session.workspace.trim())
    .sort((left, right) => left.index - right.index || left.threadId.localeCompare(right.threadId));
}

function selectedIndex(planId: string, count: number): number {
  return createHash("sha256").update(planId).digest().readUInt32BE(0) % count;
}

export function resolvePlanSecretaryAssignment(
  plan: PlanItem,
  sessions: readonly CodexPlanAssistantSession[] | undefined,
  assignedAt = new Date().toISOString()
): PlanSecretaryAssignment | undefined {
  const candidates = orderedSessions(sessions);
  if (!candidates.length) return undefined;
  const existing = candidates.find((session) => sameBinding(plan.secretaryBinding, session));
  const selected = existing || candidates[selectedIndex(plan.id, candidates.length)]!;
  return {
    target: {
      threadId: selected.threadId,
      threadName: selected.threadName,
      workspace: selected.workspace,
      index: selected.index
    },
    binding: {
      agentType: "codex",
      sessionId: selected.threadId,
      sessionTitle: selected.threadName,
      workspace: selected.workspace,
      assignedAt: existing ? plan.secretaryBinding?.assignedAt : assignedAt
    },
    changed: !existing
      || plan.secretaryBinding?.sessionTitle !== selected.threadName
      || plan.secretaryBinding?.assignedAt == null
  };
}
