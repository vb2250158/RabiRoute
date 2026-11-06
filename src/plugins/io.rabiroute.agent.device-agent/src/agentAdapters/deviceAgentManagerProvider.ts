import { createDeviceAgentOwner } from "./deviceAgentOwner.js";
import { createDeviceAgentOperations } from "./deviceAgentOperations.js";
import { createDeviceAgentEndpointBridge } from "../manager/deviceAgentEndpointBridge.js";
import { handleDeviceAgentThreadRequest, handlesDeviceAgentThreadRequest } from "../manager/deviceAgentThreads.js";
import { commonManagerOperations, bridgeOperations, createAgentScanOperations, type AgentOwnedManager } from "@rabiroute/host-api/agentAdapters/managerNativeOperations";
import type { AgentManagerImplementationOptions } from "@rabiroute/host-api/manager/agentManagerHostPorts";
import type { AgentManagerDescriptor } from "@rabiroute/host-api/manager/agentManagerProviders";
import type { AgentDeviceEndpointBridge } from "@rabiroute/host-api/manager/agentEndpointDelivery";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";

type DeviceContext = NonNullable<ReturnType<NonNullable<AgentManagerImplementationOptions["host"]["deviceContext"]>>>;
type DeviceResource = {
  key: string;
  owner: ReturnType<typeof createDeviceAgentOwner>;
  bridge: ReturnType<typeof createDeviceAgentEndpointBridge>;
  context: DeviceContext;
};

export function createManager(
  options: AgentManagerImplementationOptions,
  descriptor: AgentManagerDescriptor,
  signal: AbortSignal
): AgentOwnedManager {
  let current: DeviceResource | undefined;
  function resource(): DeviceResource {
    const context = options.host.deviceContext?.();
    if (!context) throw Object.assign(new Error("Device Agent connection context is unavailable."), { statusCode: 503 });
    if (current?.key === context.key) return current;
    const owner = createDeviceAgentOwner(context.ownerOptions);
    const bridge = createDeviceAgentEndpointBridge({ ...context.endpointOptions, owner });
    current = { key: context.key, owner, bridge, context };
    return current;
  }
  const deviceEndpoint: AgentDeviceEndpointBridge = {
    handlesThreadRequest: request => {
      if (request.action === "send" || request.action === "reconcile_delivery") return false;
      if (request.agentAdapter) return request.agentAdapter === descriptor.type;
      if (!options.host.deviceContext) return false;
      const native = resource();
      return handlesDeviceAgentThreadRequest(request, {
        ownerInstanceId: native.context.ownerOptions.ownerInstanceId,
        scope: native.context.endpointOptions.scope,
        owner: native.owner
      });
    },
    handlesSource: (_request, principal) => principal?.deviceOwner === true,
    handlesTarget: request => {
      if (request.agentAdapter) return request.agentAdapter === descriptor.type;
      if (!options.host.deviceContext) return false;
      return resource().bridge.handlesTarget?.(request) === true;
    },
    resolveSource: (...args) => resource().bridge.resolveSource(...args),
    resolveTarget: (...args) => resource().bridge.resolveTarget(...args),
    authorize: (...args) => resource().bridge.authorize(...args),
    refresh: (...args) => resource().bridge.refresh?.(...args) ?? Promise.resolve(),
    transport: (...args) => resource().bridge.transport(...args)
  };
  return {
    operations: {
      ...bridgeOperations("device", deviceEndpoint),
      ...commonManagerOperations(options, descriptor, signal),
      scan: () => {
        const native = resource();
        const scope = native.context.endpointOptions.scope();
        const agents = scope ? native.owner.agents(scope) : [];
        const sessions = scope ? native.owner.sessions(scope) : [];
        return {
          agents: { deviceAgent: {
            ...descriptor.manifest,
            installed: agents.length > 0,
            projects: [],
            sessions: sessions.map(row => ({ id: row.sessionId, ownerId: row.agentId, name: row.name, live: row.loaded, updatedAt: row.updatedAt })),
            warnings: scope ? [] : ["Device Agent connection is not configured."]
          } },
          cwdOptions: []
        };
      },
      "threads.request": (payload, invocation) => {
        const native = resource();
        const args = invocation?.nativeArgs as [unknown, AgentThreadRequestOptions] | undefined;
        return handleDeviceAgentThreadRequest(payload.request, args?.[1] ?? { requestAuthority: invocation?.assertCurrent }, {
          ownerInstanceId: native.context.ownerOptions.ownerInstanceId,
          scope: native.context.endpointOptions.scope,
          owner: native.owner
        });
      }
    },
    deviceEndpoint,
    apiOperations: invoke => [
      ...createAgentScanOperations(descriptor.type, {}, invoke),
      ...createDeviceAgentOperations(() => resource().owner)
    ],
    dispose() { current = undefined; }
  };
}
