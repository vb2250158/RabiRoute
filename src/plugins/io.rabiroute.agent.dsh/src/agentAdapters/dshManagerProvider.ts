import { DshConnectionStore } from "../dshConnectionStore.js";
import { createDshNativeOperations } from "../manager/providerNativeOperations.js";
import { sendDshTask } from "../../apps/rabi-agent/lib/dsh.mjs";
import * as endpointOwner from "./dshOwnerExecution.js";
import * as runtime from '../dshSessionBridge.js';
import { createDshConnectionOperations } from '../manager/dshConnectionOperations.js';
import { DshOwnerRecovery } from '../dshOwnerRecovery.js';
import { updateHooks } from './dshHookInstallation.js';
import { handleDshConnectionRequest } from '../manager/dshConnectionRoutes.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
import type http from 'node:http';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const recovery = new DshOwnerRecovery();
  return {
    operations: {
      "ds-bot.request": (payload, invocation) => {
        const guard = Array.isArray(invocation?.nativeArgs) ? invocation.nativeArgs[0] : undefined;
        if (guard !== undefined && typeof guard !== "function") throw new Error("Original new-task admission callback is invalid.");
        return endpointOwner.executeDsBotRequestOnOwner(payload.request, { baseUrl: payload.baseUrl, assertAuthorized: invocation?.assertCurrent,
          assertNewAgentTask: typeof guard === "function" ? () => guard() : undefined, signal: invocation?.signal });
      },
      "remote.task": (payload, invocation) => {
        invocation?.assertCurrent?.();
        return sendDshTask({ baseUrl: payload.baseUrl, sessionId: payload.threadId }, payload.prompt);
      },
      "endpoint.execute": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.executeEndpointOnOwner> | undefined;
        if (!args) throw new Error("Original native endpoint arguments are required.");
        return endpointOwner.executeEndpointOnOwner(...args);
      },
      "endpoint.recover": () => undefined,
      ...commonManagerOperations(options, descriptor, signal, {
        model: 'dshModel', reasoningEffort: 'dshReasoningEffort', dshBaseUrl: 'dshBaseUrl'
      }),
      ...nativeOperations({
        readDshPrimaryBindingAsync: runtime.readDshPrimaryBindingAsync,
        listDshSessions: runtime.listDshSessions, readDshSession: runtime.readDshSession, resolveDshSession: runtime.resolveDshSession, openDshSession: runtime.openDshSession, renameDshSession: runtime.renameDshSession, sendDshSessionMessage: runtime.sendDshSessionMessage
      }),
      ensureCompanionOwner: async (payload, invocation) => {
        invocation?.assertCurrent?.();
        const binding = await runtime.readDshPrimaryBindingAsync(payload.configPath);
        if (!binding)
          throw new Error('The original DSH binding is unavailable.');
        const result = await recovery.ensure(binding);
        invocation?.assertCurrent?.();
        return result;
      },
      connection: (_payload, invocation) => {
        if (!invocation?.request || !invocation.url)
          throw new Error('The original connection request is required.');
        return handleDshConnectionRequest(invocation.request as http.IncomingMessage, invocation.url as URL, undefined, invocation.signal, invocation.parsedBody as {
          value: unknown;
          signal?: AbortSignal;
        } | undefined);
      },
      'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot)
    },
    apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {
        dshLimit: 200, dshOffset: 0, dshQuery: null, dshBaseUrl: null
      }, invoke, ['/api/scan/agents/dsh'], ['agent.adapters.dsh.get']), ...createDshConnectionOperations(invoke), ...createDshNativeOperations({ configuredTargets: () => {
        const definitions = [...options.host.getRuntimes()].map(runtime => runtime.definition);
        return {
          localBaseUrls: [...definitions.filter(definition => definition.agentAdapters?.includes("dsh") && definition.dshBaseUrl).map(definition => definition.dshBaseUrl!), ...new DshConnectionStore().readMetadata().connections.filter(connection => connection.state !== "disconnected").map(connection => connection.baseUrl)],
          remoteTargetIds: [...new Set(definitions.flatMap(definition => (definition.remoteAgentTargets ?? []).filter(target => target.provider === "dsh").map(target => target.id)))]
        };
      } })]
  };
}
