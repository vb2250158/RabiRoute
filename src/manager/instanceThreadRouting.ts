import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import type { AgentInstance } from "../shared/agentInstance.js";
import { normalizeAgentInstanceBinding } from "../shared/agentInstance.js";

export type InstanceThreadTransport = {
  instances: () => AgentInstance[];
  manage: (instanceId: string, params: Record<string, unknown>) => Promise<unknown>;
  endpointDelivery?: (request: AgentThreadRequest) => Promise<AgentThreadRequestResult>;
};

/** Resolve identity before any local provider lookup, including when the remote computer is offline. */
export async function routeInstanceThread(request: AgentThreadRequest, transport: InstanceThreadTransport): Promise<AgentThreadRequestResult | undefined> {
  if (request.agentTargetId !== undefined) {
    if (!request.agentAdapter || request.agentTargetId !== `local:${request.agentAdapter}` || request.instanceBinding) {
      throw new Error("Explicit local task target must match its provider and cannot include a remote binding.");
    }
    return undefined;
  }
  const binding = normalizeAgentInstanceBinding(request.instanceBinding);
  if (!binding) return undefined;
  const instance = transport.instances().find(item => item.instanceId === binding.instanceId);
  if (instance?.local) return undefined;
  if (!instance?.connected || instance.enabled === false) throw new Error("The target instance is offline or disabled.");
  const provider = request.agentAdapter;
  if (!provider) throw new Error("Explicit Agent type is required; query the provider directory.");
  if (request.imagePaths?.length) throw new Error("Local image paths cannot be used on another instance.");
  if (request.action === "send" || request.action === "reconcile_delivery") {
    if (!transport.endpointDelivery) throw new Error("Remote delivery requires the Manager-owned authenticated endpoint pipeline.");
    return transport.endpointDelivery({ ...request, instanceBinding: binding });
  }
  const { instanceBinding: _binding, ...params } = request;
  const result = await transport.manage(instance.instanceId, { ...params, agentId: binding.agentId, agentAdapter: provider }) as AgentThreadRequestResult;
  if (!result || !Number.isInteger(result.statusCode) || !result.data) throw new Error("The instance returned an invalid task result.");
  return result;
}
