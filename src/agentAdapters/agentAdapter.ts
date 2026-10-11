import { createDeviceAgentAdapter, type DeviceAgentAdapterOptions } from "./deviceAgentAdapter.js";
import { getBuiltinAgentAdapterRuntime } from "../runtime/agentAdapterRuntime.js";
import type { AgentAdapterType } from "./types.js";
import { configuredInstanceBinding } from "./instanceClient.js";
import { notifyInstanceAgent } from "./lanAgentAdapter.js";
import type { AgentAdapter } from "./contracts.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";

export type { AgentAdapter, AgentDeliveryOptions } from "./contracts.js";

export async function createAgentAdapter(type: AgentAdapterType, target: "primary" | "local" | { binding: AgentInstanceBinding } = "primary", options: { deviceAgent?: DeviceAgentAdapterOptions } = {}): Promise<AgentAdapter> {
  // Unit/integration tests must inject their delivery boundary. Never let a
  // missed mock execute against a developer's real Desktop or remote owner.
  if (process.env.NODE_TEST_CONTEXT && !(type === "deviceAgent" && options.deviceAgent?.request)) {
    throw new Error("Real Agent adapter delivery is disabled in the Node test runner; inject an isolated delivery adapter.");
  }
  const binding = typeof target === "object" ? target.binding : target === "primary" ? configuredInstanceBinding(type) : undefined;
  // Device binding addresses the device owner mailbox, never the generic PC Agent endpoint.
  if (type === "deviceAgent") return createDeviceAgentAdapter(binding, options.deviceAgent);
  if (binding) return { type, deliver: (envelope, options) => notifyInstanceAgent(type, binding, envelope, options) };
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.create(type);
}

export async function listRegisteredAgentAdapterManifests() {
  const runtime = await getBuiltinAgentAdapterRuntime();
  return runtime.registry.listManifests();
}
