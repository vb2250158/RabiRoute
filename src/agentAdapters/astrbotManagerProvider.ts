import { createAstrbotControlOperations } from '../manager/agentProviderControlRoutes.js';
import { testAstrbotLogin } from './astrbotManagerApi.js';
import { commonManagerOperations, createAgentScanOperations, type AgentOwnedManager } from './managerNativeOperations.js';
import type { AgentManagerImplementationOptions } from '../manager/agentManagerHostPorts.js';
import type { AgentManagerDescriptor } from '../manager/agentManagerProviders.js';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal), 'login.test': payload => testAstrbotLogin(payload)
    }, apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {}, invoke), ...createAstrbotControlOperations(payload => invoke('login.test', payload))]
  };
}
