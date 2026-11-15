import type { AgentAdapterProvider } from '@rabiroute/plugin-sdk';
import type { AgentThreadRequest, AgentThreadRequestResult } from '../agentThreads.js';
import type { AgentServiceSourcePrincipal } from './agentEndpointDelivery.js';

/** A native provider reference is the capability. JSON and message metadata cannot mint it. */
export function createOwnedServiceAgentSender(options: {
  providers(): readonly AgentAdapterProvider[];
  deliveryAuthorityId(): string;
  assertCurrent(): void;
  dispatch(request: AgentThreadRequest, source: AgentServiceSourcePrincipal, guard: () => void): Promise<AgentThreadRequestResult>;
}) {
  return Object.freeze({ bind(provider: AgentAdapterProvider) {
    const guard = () => {
      options.assertCurrent();
      if (!options.providers().some(current => current === provider) || !provider.inspect().accepting) {
        throw new Error('AGENT_SOURCE_OWNER_RETIRED');
      }
    };
    return async (request: AgentThreadRequest, expectedSessionId: string) => {
      let dispatched=false;
      try {
      guard();
      if (!['send', 'reconcile_delivery'].includes(request.action || '')) throw new Error('AGENT_SOURCE_ACTION_UNSUPPORTED');
      if (!expectedSessionId) throw new Error('AGENT_SOURCE_SESSION_REQUIRED');
      // These fields are exclusively injected from the current published provider.
      if (['messageSource', 'sourceThreadId', 'sourceAgentType'].some(key => key in request)) throw new Error('AGENT_SOURCE_METADATA_NOT_CALLER_SETTABLE');
      return await provider.runAcceptedWork(async () => {
        guard();
        const binding = await provider.invoke<{ sessionId?: string }>('binding.read', {}, { assertCurrent: guard });
        guard();
        if (binding.sessionId !== expectedSessionId) throw new Error('AGENT_SOURCE_CONTEXT_CHANGED');
        const party = await provider.invoke<{ endpoint?: { kind: string; provider: string; managerInstanceId?: string; agentId: string; sessionId: string; authorizationIncarnation: string }; threadName?: string; workspace?: string }>(
          'service.resolveTarget', {}, { assertCurrent: guard, nativeArgs: [{ agentAdapter: provider.type, threadId: expectedSessionId }] });
        guard();
        const endpoint = party.endpoint,authorityId=options.deliveryAuthorityId();
        if (!endpoint || endpoint.kind !== 'service' || endpoint.provider !== provider.type || endpoint.sessionId !== expectedSessionId
          || typeof endpoint.agentId!=='string'||!endpoint.agentId.trim()||typeof endpoint.authorizationIncarnation!=='string'||!endpoint.authorizationIncarnation.trim()
          || typeof authorityId!=='string'||!authorityId.trim()||endpoint.managerInstanceId!==authorityId) throw new Error('AGENT_SOURCE_ENDPOINT_INVALID');
        const source: AgentServiceSourcePrincipal = Object.freeze({ provider: provider.type, agentId: endpoint.agentId,
          sessionId: endpoint.sessionId, authorizationIncarnation: endpoint.authorizationIncarnation });
        dispatched=true;
        return await options.dispatch({ ...request, sourceThreadId: expectedSessionId, sourceAgentType: provider.type,
          messageSource: { type: 'agent', agentAdapter: provider.type, sessionId: expectedSessionId,
            sessionName: party.threadName || expectedSessionId, workspace: party.workspace } }, source, guard);
      });
      } catch(error) {
        if(!dispatched&&error instanceof Error)Object.assign(error,{dispatched:false});
        throw error;
      }
    };
  } });
}
