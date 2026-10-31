import { getTimeoutMs } from "./timeoutSettingsClient";
import { remotePersonaServicePath } from "./persona/remotePersonaReference";
import { browserUuid } from "./browserUuid";

export type RoleRequestFailure = {
  status?: number;
  uncertain?: boolean;
  mutationOutcome?: "not_started" | "unknown";
};

export async function roleRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(getTimeoutMs("webgui.role.configuration", 30000))]) });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw Object.assign(new Error(body.message || `角色请求失败 (${response.status})`), {
    status: response.status,
    uncertain: body.uncertain === true,
    mutationOutcome: body.mutationOutcome === "unknown" || body.mutationOutcome === "not_started" ? body.mutationOutcome : undefined
  } satisfies RoleRequestFailure);
  return body.data as T;
}

export async function mutateRole<T>(roleId: string, action: string, body: unknown, source = ""): Promise<T> {
  const url = `/api/roles/${encodeURIComponent(roleId)}/${action}`;
  const key = `rabi:role-operation:${source}:${roleId}:${action}`;
  const previous = sessionStorage.getItem(key);
  const pending: { id: string; body: unknown } = previous ? JSON.parse(previous) : { id: browserUuid(), body };
  sessionStorage.setItem(key, JSON.stringify(pending));
  try {
    const result = await roleRequest<T>(source ? remotePersonaServicePath(source, url) : url, {
      method: action === "configuration" ? "PUT" : "POST",
      headers: { "content-type": "application/json", "idempotency-key": pending.id }, body: JSON.stringify(pending.body)
    });
    sessionStorage.removeItem(key);
    if (previous && JSON.stringify(pending.body) !== JSON.stringify(body)) {
      throw Object.assign(new Error("上一次角色操作已确认。当前草稿已保留，请再次保存。"), { confirmedRole: result });
    }
    return result;
  } catch (error) {
    const { status, uncertain, mutationOutcome } = error as RoleRequestFailure;
    if (status && status >= 400 && status < 500 && uncertain !== true && mutationOutcome !== "unknown") sessionStorage.removeItem(key);
    throw error;
  }
}
