import type { AgentAdapterType } from "./types.js";

export type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
};

export function reportAgentState(adapterType: AgentAdapterType, state: Record<string, unknown>): void {
  const managerUrl = process.env.GATEWAY_MANAGER_URL?.trim();
  const gatewayId = process.env.GATEWAY_ID?.trim();
  if (!managerUrl || !gatewayId) {
    return;
  }

  const url = `${managerUrl.replace(/\/$/, "")}/api/agent-state`;
  const payload = JSON.stringify({
    gatewayId,
    adapterType,
    state: {
      ...state,
      agentAdapterType: adapterType
    }
  });

  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload
  }).catch(() => {
    // Agent delivery should not fail just because the manager status endpoint is unavailable.
  });
}
