import { memoryConsolidationAgentStatePath, readMemoryConsolidationAgentState } from "../memoryConsolidationAgent.js";
import { listConsolidationRuns } from "../roleKnowledge.js";
import type { CodexHookContextRequest } from "./codexHookContext.js";

export type ConsolidationHookTarget = {
  roleId: string;
  roleDir: string;
  dataDir: string;
};

/** A dedicated session is identified by its Manager-owned route binding, never by a plan or a guessed latest run. */
export function memoryConsolidationHookScope(
  request: CodexHookContextRequest,
  roleId: string,
  runId: string | undefined,
  targets: readonly ConsolidationHookTarget[]
): { runId?: string; inputMemoryIds: readonly string[] } | undefined {
  const matching = targets.flatMap((target) => {
    const binding = readMemoryConsolidationAgentState(memoryConsolidationAgentStatePath(target.dataDir)).binding;
    return binding?.threadId === request.sessionId ? [{ target, binding }] : [];
  });
  if (!matching.length) return undefined;
  // Ambiguous or mismatched route ownership must not grant role-wide recall.
  if (matching.length !== 1 || matching[0]!.target.roleId !== roleId || !runId ||
      matching[0]!.binding.agentAdapter !== request.agentType) {
    return { inputMemoryIds: [] };
  }
  const run = listConsolidationRuns(matching[0]!.target.roleDir).find((item) => item.id === runId);
  if (!run || run.status !== "requested" || !run.deliveredAt) return { inputMemoryIds: [] };
  return { runId: run.id, inputMemoryIds: run.inputMemoryIds };
}
