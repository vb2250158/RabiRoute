import type { RouteAgentTarget } from "@shared/routeAgentTargets";

/** The caller freezes the concrete target for a whole multi-step operation. Never retry remotely failed work locally. */
export async function postRouteAgentThreadAction(
  payload: Record<string, unknown>,
  target: RouteAgentTarget | undefined,
  options: { fetch?: typeof fetch; accessToken: () => string }
): Promise<Record<string, any>> {
  const request = options.fetch || globalThis.fetch;
  if (target?.binding) {
    const accessResponse = await request("/api/webgui-access");
    const access = await accessResponse.json();
    if (!accessResponse.ok) throw new Error(access.message || "无法读取远端访问凭据");
    const response = await request(`/api/lan-agent/instances/${encodeURIComponent(target.binding.instanceId)}/agents/${encodeURIComponent(target.binding.agentId)}/threads`, {
      method: "POST", headers: { "content-type": "application/json", "x-rabiroute-webgui-token": access.data?.token || options.accessToken() },
      body: JSON.stringify({ ...payload, agentAdapter: target.provider })
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || body.result?.statusCode >= 400) throw new Error(body.result?.data?.message || body.message || "远端会话操作失败");
    if (!body.result?.data) throw new Error("远端会话操作未返回结果，请核对任务状态后再操作");
    return { code: 0, ...body.result.data };
  }
  const provider = target?.provider || payload.agentAdapter;
  if (typeof provider !== "string" || !provider) throw new Error("本机会话操作需要明确 Agent 类型。");
  const response = await request("/api/agent/threads", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, agentAdapter: provider, agentTargetId: `local:${provider}` })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code === -1) throw new Error(body.message || "Agent 会话操作失败。");
  return body;
}
