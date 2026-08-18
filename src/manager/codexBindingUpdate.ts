import { isCodexTaskId } from "../codexTaskIdentity.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";

export type ReportedCodexBindingUpdate = {
  threadId: string;
  threadName?: string;
  workspace: string;
};

export function resolveReportedCodexBindingUpdate(
  definition: { codexThreadId?: string; codexCwd?: string },
  state: Record<string, unknown>
): ReportedCodexBindingUpdate | null {
  if (!String(state.bindingUpdateRequestedAt || "").trim()) return null;
  const threadId = String(state.bindingThreadId || "").trim();
  const previousThreadId = String(state.bindingPreviousThreadId || "").trim();
  const workspace = String(state.bindingWorkspace || "").trim();
  const configuredThreadId = String(definition.codexThreadId || "").trim();
  const configuredWorkspace = String(definition.codexCwd || "").trim();
  if (!isCodexTaskId(threadId) || !workspace) return null;
  if (configuredThreadId !== previousThreadId && configuredThreadId !== threadId) return null;
  if (configuredWorkspace && normalizePathForComparison(configuredWorkspace) !== normalizePathForComparison(workspace)) {
    return null;
  }
  if (configuredThreadId === threadId) return null;
  const threadName = String(state.bindingThreadName || "").trim();
  return { threadId, workspace, ...(threadName ? { threadName } : {}) };
}
