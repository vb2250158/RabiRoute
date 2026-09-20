import type { HomeAssistantDeploymentConfig, HomeAssistantDeploymentSnapshot } from "@shared/homeAssistantDeploymentContract";

async function request(method: string, body?: unknown, suffix = ""): Promise<HomeAssistantDeploymentSnapshot> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    const response = await fetch("/meta");
    const meta = await response.json();
    if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw new Error("Manager 状态已变化，请刷新页面。");
    headers["content-type"] = "application/json";
    headers["x-rabiroute-expected-application-generation-id"] = meta.applicationGenerationId;
    headers["x-rabiroute-expected-manager-instance-id"] = meta.managerInstanceId;
  }
  const response = await fetch(`/api/agent/xiaomi-home/deployment${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.error?.message || "Home Assistant 部署操作失败。");
  return result.data;
}

export const homeAssistantDeploymentClient = {
  read: () => request("GET"),
  save: (config: HomeAssistantDeploymentConfig, revision: string) => request("PUT", { config, revision }),
  start: (revision: string) => request("POST", { revision }, "/start")
};
