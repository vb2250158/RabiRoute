import { createMarvisControlOperations } from '../manager/marvisControlOperations.js';
import { openMarvis } from './marvisManagerApi.js';
import { commonManagerOperations, createAgentScanOperations, type AgentOwnedManager } from './managerNativeOperations.js';
import type { AgentManagerImplementationOptions } from '../manager/agentManagerHostPorts.js';
import type { AgentManagerDescriptor } from '../manager/agentManagerProviders.js';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal), 'open': payload => openMarvis({
        rootDir: options.host.rootDir
      }, payload)
    }, apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {}, invoke), ...createMarvisControlOperations(body => invoke('open', body))]
  };
}
