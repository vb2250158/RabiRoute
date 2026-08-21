import { sameCodexWorkspace } from "../codexTaskIdentity.js";

export type AgentThreadRouteCandidate = {
  id: string;
  ownedSessionIds: readonly string[];
  supportsDsh: boolean;
  dshWorkspaces: readonly string[];
};

export type AgentThreadRouteSelectionInput = {
  targetSessionId?: string;
  messageSourceSessionId?: string;
  sourceThreadId?: string;
  needsDsh: boolean;
  workspace?: string;
};

/** Select one Route only when session identity or DSH workspace makes it unique. */
export function selectAgentThreadRouteId(
  input: AgentThreadRouteSelectionInput,
  candidates: readonly AgentThreadRouteCandidate[]
): string | undefined {
  const ids = [input.targetSessionId, input.messageSourceSessionId, input.sourceThreadId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const sessionId of ids) {
    const exact = candidates.filter((candidate) => candidate.ownedSessionIds.includes(sessionId));
    if (exact.length === 1) return exact[0].id;
  }
  if (!input.needsDsh) return undefined;

  const workspace = String(input.workspace || "").trim();
  const dshCandidates = candidates.filter((candidate) => (
    candidate.supportsDsh
    && (!workspace || candidate.dshWorkspaces.some((item) => sameCodexWorkspace(item, workspace)))
  ));
  return dshCandidates.length === 1 ? dshCandidates[0].id : undefined;
}
