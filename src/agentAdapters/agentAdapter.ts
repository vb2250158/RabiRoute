import { getBuiltinAgentAdapterRuntime } from "../runtime/agentAdapterRuntime.js";
import type { AgentAdapterType } from "./types.js";

export type { AgentAdapter, AgentDeliveryOptions } from "./contracts.js";

const builtinRuntime = await getBuiltinAgentAdapterRuntime();

export function createAgentAdapter(type: AgentAdapterType) {
  return builtinRuntime.registry.create(type);
}

export function listRegisteredAgentAdapterManifests() {
  return builtinRuntime.registry.listManifests();
}
