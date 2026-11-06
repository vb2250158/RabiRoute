import { CopilotControlService } from '../manager/agentProviderControlService.js';
import { createCopilotControlOperations } from '../manager/copilotControlOperations.js';
import { getCopilotStatus } from './copilotManagerApi.js';
import { commonManagerOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const service = new CopilotControlService();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= service.stop();
  const abort = () => {
    void stop().catch(() => {
    });
  };
  signal.addEventListener('abort', abort, {
    once: true
  });
  return {
    operations: {
      ...commonManagerOperations(options, descriptor, signal, {
        model: 'copilotModel', reasoningEffort: 'copilotReasoningEffort'
      }), 'status': () => getCopilotStatus({
        rootDir: options.host.rootDir
      }), 'install': () => service.install(), 'login': (_payload, invocation) => service.login(invocation?.callbacks as Parameters<CopilotControlService['login']>[0])
    },
    apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {}, invoke), ...createCopilotControlOperations({
        installCopilot: () => invoke('install', {}), startCopilotLogin: callbacks => invoke('login', {}, {
          callbacks
        }), getCopilotStatus: () => invoke('status', {}), publishEvent: options.host.publishManagerEvent
      })], dispose: async () => {
      signal.removeEventListener("abort", abort);
      await stop();
    }
  };
}
