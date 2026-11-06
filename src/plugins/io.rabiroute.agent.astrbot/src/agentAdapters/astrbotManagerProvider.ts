import { createAstrbotControlOperations } from '../manager/astrbotControlOperations.js';
import { testAstrbotLogin } from './astrbotManagerApi.js';
import { commonManagerOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal), 'login.test': payload => testAstrbotLogin(payload)
    }, apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {}, invoke), ...createAstrbotControlOperations(payload => invoke('login.test', payload))]
  };
}
