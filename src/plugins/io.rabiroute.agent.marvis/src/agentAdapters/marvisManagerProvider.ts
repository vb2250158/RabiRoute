import { createMarvisControlOperations } from '../manager/marvisControlOperations.js';
import { openMarvis } from './marvisManagerApi.js';
import { commonManagerOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal), 'open': payload => openMarvis({
        rootDir: options.host.rootDir
      }, payload)
    }, apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {}, invoke), ...createMarvisControlOperations(body => invoke('open', body))]
  };
}
