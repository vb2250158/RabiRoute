import { getTimeoutMs } from "./timeoutSettingsClient";
import type { CompanionCommand, CompanionSession, CompanionSnapshot } from "@shared/companionActivity";
export async function companionRequest(roleId: string, action = "", body?: unknown, signal?: AbortSignal, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<CompanionSnapshot> {
  const response = await fetchImpl(`/api/roles/${encodeURIComponent(roleId)}/companion${action ? `/${action}` : ""}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(action === "review" ? getTimeoutMs("webgui.companion.review", 50000) : getTimeoutMs("webgui.companion.request", 15000))]),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || `HTTP ${response.status}`);
  return result.data;
}

export function setCompanionMode(roleId: string, session: Pick<CompanionSession, "id" | "revision">,
  presetId: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<CompanionSnapshot> {
  const command: CompanionCommand = {
    sessionId: session.id, revision: session.revision, action: "set-mode", presetId
  };
  return companionRequest(roleId, "command", command, signal, fetchImpl);
}
