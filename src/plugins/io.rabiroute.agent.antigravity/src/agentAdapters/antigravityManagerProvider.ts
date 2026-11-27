import { readAntigravitySession, listAntigravitySessions } from '../antigravitySessionStore.js';
import { readAntigravityHistory } from '../antigravityTranscript.js';
import { updateHooks } from './antigravityHookInstallation.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  return {
    operations: {
      // The transcript is the only readable form of an Antigravity conversation, so this
      // provider answers threads.history from it instead of leaving the shared caller to fail.
      "threads.history": payload => readAntigravityHistory(payload.sessionId, { limit: payload.limit }),
      ...commonManagerOperations(options, descriptor, signal), ...nativeOperations({
        readAntigravitySession, listAntigravitySessions
      }), 'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot, undefined, {
        signal: invocation?.signal
      })
    }, apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      antigravityLimit: 200, antigravityOffset: 0, antigravityQuery: null, antigravityWorkspace: null
    }, invoke)
  };
}
