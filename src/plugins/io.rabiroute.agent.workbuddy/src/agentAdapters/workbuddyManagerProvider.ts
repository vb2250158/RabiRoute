import * as endpointOwner from "./workbuddyOwnerExecution.js";
import * as threads from '../workbuddyThreads.js';
import { readWorkbuddyHistory } from '../workbuddyHistory.js';
import { requestWorkbuddyDesktopCreation } from '../workbuddyDesktopRelay.js';
import type { WorkbuddyDesktopCreationInput } from '../workbuddyDesktopCreation.js';
import { updateHooks } from './workbuddyHookInstallation.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      "threads.create": async (payload: WorkbuddyDesktopCreationInput, invocation) => {
        invocation?.assertCurrent?.();
        if (options.host.readOnly()) throw new Error("Manager is read-only.");
        const combined = invocation?.signal ? AbortSignal.any([signal, invocation.signal]) : signal;
        return requestWorkbuddyDesktopCreation(payload, combined);
      },
      "threads.history": (payload, invocation) => readWorkbuddyHistory(payload.sessionId, {
        cursor: payload.cursor, limit: payload.limit, signal: invocation?.signal,
        assertAuthorized: invocation?.assertCurrent
      }),
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
