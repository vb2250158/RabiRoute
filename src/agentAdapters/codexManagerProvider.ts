import { CodexRemoteTaskOwner } from "./codexRemoteTask.js";
import * as endpointOwner from "./codexOwnerExecution.js";
import * as runtime from '../codexRuntime.js';
import { readCodexDesktopThread, subscribeCodexDesktopDelivery, openCodexDesktopThread, codexDesktopDeliveryReceiptConfirmed } from '../codexDesktopBridge.js';
import { readCodexTurnImages } from '../manager/completionImages.js';
import { recoverAgentResponseDeliveryFromRollout } from './codexReceiptRecovery.js';
import { updateHooks } from './codexHookInstallation.js';
import type { AgentRequestStore } from '../agentRequests/store.js';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from './managerNativeOperations.js';
import type { AgentManagerImplementationOptions } from '../manager/agentManagerHostPorts.js';
import type { AgentManagerDescriptor } from '../manager/agentManagerProviders.js';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const remoteTasks = new CodexRemoteTaskOwner(options.host);
  let unsubscribe: (() => void) | undefined;
  return {
    operations: {
      "remote.task": (payload, invocation) => remoteTasks.execute(payload, invocation),
      "endpoint.execute": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.executeEndpointOnOwner> | undefined;
        if (!args) throw new Error("Original native endpoint arguments are required.");
        return endpointOwner.executeEndpointOnOwner(...args);
      },
      "endpoint.recover": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.recoverEndpointOwnerReceipt> | undefined;
        if (!args) throw new Error("Original native receipt arguments are required.");
        return endpointOwner.recoverEndpointOwnerReceipt(...args);
      },
      ...commonManagerOperations(options, descriptor, signal, {
        model: 'agentModel', reasoningEffort: 'agentReasoningEffort'
      }),
      ...nativeOperations({
        createCodexThread: runtime.createCodexThread, listCodexThreads: runtime.listCodexThreads, readCodexThread: runtime.readCodexThread, renameCodexThread: runtime.renameCodexThread, sendCodexThreadMessage: runtime.sendCodexThreadMessage, openCodexDesktopThread, codexDesktopDeliveryReceiptConfirmed
      }),
      readCodexDesktopThread: payload => readCodexDesktopThread(payload.sessionId),
      recoverResponseDelivery: (payload, invocation) => {
        if (!invocation?.store)
          throw new Error('The original Agent request store is required.');
        return recoverAgentResponseDeliveryFromRollout(invocation.store as AgentRequestStore, payload.sourceThreadId, payload.pendingDeliveryId);
      },
      readCompletionImages: async (payload, invocation) => {
        const thread = readCodexDesktopThread(payload.sessionId);
        return thread?.rolloutPath ? readCodexTurnImages(thread.rolloutPath, payload.turnId, invocation?.onError as ((error: Error) => void) | undefined) : [];
      },
      'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot)
    },
    apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      codexLimit: 200, codexOffset: 0, codexQuery: null, codexCatalogTimeoutMs: null
    }, invoke),
    start() {
      unsubscribe ??= subscribeCodexDesktopDelivery(event => {
        if (event.stage === 'delivery_receipt_confirmed' && event.late)
          options.host.deliveryReceiptChanged();
      });
    },
    unpublish() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
    async dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      remoteTasks.dispose();
      await runtime.disposeCodexAdapterTransport?.();
    }
  };
}
