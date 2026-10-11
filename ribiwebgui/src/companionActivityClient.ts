import type { CompanionSnapshot } from "@shared/companionActivity";
export async function companionRequest(roleId: string, action = "", body?: unknown, signal?: AbortSignal): Promise<CompanionSnapshot> {
  const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/companion${action ? `/${action}` : ""}`, {
    method: body === undefined ? "GET" : "POST", signal: signal || AbortSignal.timeout(action === "review" ? 50_000 : 15_000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || `HTTP ${response.status}`);
  return result.data;
}
