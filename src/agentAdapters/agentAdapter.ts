import { getBuiltinAgentAdapterRuntime } from "../runtime/agentAdapterRuntime.js";
import type { AgentAdapterType } from "./types.js";

export type { AgentAdapter, AgentDeliveryOptions } from "./contracts.js";

export async function createAgentAdapter(type: AgentAdapterType) {
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.create(type);
}

export async function listRegisteredAgentAdapterManifests() {
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.listManifests();
}
