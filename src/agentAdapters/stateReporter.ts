import type { AgentAdapterType } from "./types.js";
import { randomUUID } from "node:crypto";

export type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
};

const reportGeneration = process.env.AGENT_STATE_GENERATION?.trim() || randomUUID();
let reportSequence = 0;

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
    generation: reportGeneration,
    sequence: ++reportSequence,
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
