import { readAntigravitySession } from '../antigravitySessionStore.js';
import { updateHooks } from './antigravityHookInstallation.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal), ...nativeOperations({
        readAntigravitySession
      }), 'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot, undefined, {
        signal: invocation?.signal
      })
    }, apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      antigravityLimit: 200, antigravityOffset: 0, antigravityQuery: null, antigravityWorkspace: null
    }, invoke)
  };
}
