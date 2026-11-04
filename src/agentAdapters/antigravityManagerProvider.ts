import { readAntigravitySession } from '../antigravitySessionStore.js';
import { updateHooks } from './antigravityHookInstallation.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from './managerNativeOperations.js';
import type { AgentManagerImplementationOptions } from '../manager/agentManagerHostPorts.js';
import type { AgentManagerDescriptor } from '../manager/agentManagerProviders.js';
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
