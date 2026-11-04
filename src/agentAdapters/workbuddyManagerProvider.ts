import * as endpointOwner from "./workbuddyOwnerExecution.js";
import * as threads from '../workbuddyThreads.js';
import { updateHooks } from './workbuddyHookInstallation.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from './managerNativeOperations.js';
import type { AgentManagerImplementationOptions } from '../manager/agentManagerHostPorts.js';
import type { AgentManagerDescriptor } from '../manager/agentManagerProviders.js';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      "endpoint.execute": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.executeEndpointOnOwner> | undefined;
        if (!args) throw new Error("Original native endpoint arguments are required.");
        return endpointOwner.executeEndpointOnOwner(...args);
      },
      "endpoint.recover": () => undefined,
      ...commonManagerOperations(options, descriptor, signal, {
        workbuddyEndpoint: 'workbuddyEndpoint'
      }), ...nativeOperations({
        listWorkbuddyThreads: threads.listWorkbuddyThreads, readWorkbuddyThread: threads.readWorkbuddyThread, sendWorkbuddyThreadMessage: threads.sendWorkbuddyThreadMessage
      }), 'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot, undefined, {
        signal: invocation?.signal
      })
    }, apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      workbuddyLimit: 200, workbuddyOffset: 0, workbuddyQuery: null, workbuddyWorkspace: null
    }, invoke)
  };
}
