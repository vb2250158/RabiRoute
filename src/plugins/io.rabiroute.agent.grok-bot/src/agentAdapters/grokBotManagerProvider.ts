import { createGrokBotEndpointBridge, readGrokBotNativeOwner } from '../manager/grokBotEndpointBridge.js';
import { grokBotEndpointConfiguration } from '../manager/grokBotConfiguration.js';
import { handleGrokBotThreadRequest } from '../manager/grokBotThreads.js';
import { GrokBotError } from './grokBotClient.js';
import { commonManagerOperations, bridgeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
import type { GatewayDefinition } from '@rabiroute/host-api/shared/gatewayConfigModel';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const configuration = (sessionId?: string) => grokBotEndpointConfiguration([...options.host.getRuntimes()].map(row => row.definition as GatewayDefinition), sessionId);
  const bridge = createGrokBotEndpointBridge({
    managerInstanceId: options.host.managerInstanceId(), configuration
  });
  return {
    operations: {
      ...bridgeOperations("service", bridge),
      ...commonManagerOperations(options, descriptor, signal),
      'threads.request': (payload, invocation) => {
        invocation?.assertCurrent?.();
        return handleGrokBotThreadRequest(payload.request, {
          ...configuration(payload.request?.threadId), dataDir: options.host.rootDir
        });
      },
      handleGrokBotThreadRequest: (payload, invocation) => {
        invocation?.assertCurrent?.();
        return handleGrokBotThreadRequest(payload.request, payload.configuration ?? configuration(payload.request?.threadId));
      },
      readGrokBotSource: async (payload, invocation) => {
        invocation?.assertCurrent?.();
        try {
          const owner = await readGrokBotNativeOwner(payload.sessionId, configuration(payload.sessionId));
          invocation?.assertCurrent?.();
          return {
            sessionId: owner.id, sessionName: owner.bot.name
          };
        }
        catch (error) {
          if (error instanceof GrokBotError && ['GROK_BOT_SESSION_NOT_FOUND', 'GROK_BOT_INVALID_OWNER_ID'].includes(error.code))
            return null;
          throw error;
        }
      },
      readGrokBotNativeOwner: (payload, invocation) => {
        invocation?.assertCurrent?.();
        return readGrokBotNativeOwner(payload.sessionId, payload.configuration ?? configuration(payload.sessionId));
      }
    },
    serviceEndpoint: bridge,
    apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      grokBotLimit: 100, grokBotOffset: 0, grokBotQuery: null, grokBotAgentId: null, grokBotProfilePath: null, grokBotBackendUrl: null
    }, invoke, ['/api/scan/agents/grokBot'], ['agent.adapters.grokBot.get'])
  };
}
