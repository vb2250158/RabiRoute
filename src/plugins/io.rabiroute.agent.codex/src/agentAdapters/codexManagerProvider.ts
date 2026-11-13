import { createCodexNativeOperations } from "../manager/providerNativeOperations.js";
import { CodexRemoteTaskOwner } from "./codexRemoteTask.js";
import * as endpointOwner from "./codexOwnerExecution.js";
import { createCodexRuntime } from '../codexRuntime.js';
import { resolveCodexSession } from '../codexSessionResolver.js';
import { promptConfirmsDelivery } from '../agentRequests/rolloutReceipt.js';
import { readCodexDesktopThread, readCodexDesktopThreadsByIds, codexDesktopDeepLinkForTest, subscribeCodexDesktopDelivery, openCodexDesktopThread, codexDesktopDeliveryReceiptConfirmed } from '../codexDesktopBridge.js';
import { readCodexTurnImages } from '../manager/completionImages.js';
import { recoverAgentResponseDeliveryFromRollout } from './codexReceiptRecovery.js';
import { updateHooks } from './codexHookInstallation.js';
import type { AgentRequestStore } from '@rabiroute/host-api/agentRequests/store';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';
export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const runtime = createCodexRuntime();
  const remoteTasks = new CodexRemoteTaskOwner(options.host);
  let unsubscribe: (() => void) | undefined;
  return {
    operations: {
      "threads.metadata": payload => readCodexDesktopThreadsByIds(payload.sessionIds).map(task => ({ id: task.id, title: task.title, url: codexDesktopDeepLinkForTest(task.id) })),
      "remote.task": (payload, invocation) => remoteTasks.execute(payload, invocation),
      "endpoint.execute": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.executeEndpointOnOwner> | undefined;
        if (!args) throw new Error("Original native endpoint arguments are required.");
        return endpointOwner.executeEndpointOnOwner(args[0], args[1], args[2], args[3] ?? { sendCodex: runtime.sendCodexThreadMessage });
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
        createCodexThread: runtime.createCodexThread, listCodexThreads: runtime.listCodexThreads, readCodexThread: runtime.readCodexThread, renameCodexThread: runtime.renameCodexThread, sendCodexThreadMessage: runtime.sendCodexThreadMessage, openCodexDesktopThread, codexDesktopDeliveryReceiptConfirmed,
        notifyCodex: runtime.notifyCodex, notifyCodexWhenIdle: runtime.notifyCodexWhenIdle, isCodexMonitorThreadActive: runtime.isCodexMonitorThreadActive,
        isCodexDesktopReady: runtime.isCodexDesktopReady, listCodexModels: runtime.listCodexModels, resolveCodexSession, promptConfirmsDelivery
      }),
      readCodexDesktopThread: payload => readCodexDesktopThread(payload.sessionId),
      recoverResponseDelivery: (payload, invocation) => {
        if (!invocation?.store)
          throw new Error('The original Agent request store is required.');
        return recoverAgentResponseDeliveryFromRollout(invocation.store as AgentRequestStore, payload.sourceThreadId, payload.pendingDeliveryId);
      },
      readCompletionImages: async (payload, invocation) => {
        const thread = readCodexDesktopThread(payload.sessionId);
        return thread?.rolloutPath ? readCodexTurnImages(thread.rolloutPath, payload.turnId, invocation?.onError as ((error: Error) => void) | undefined, thread.id) : [];
      },
      'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot)
    },
    apiOperations: invoke => [...createAgentScanOperations(descriptor.type, {
      codexLimit: 200, codexOffset: 0, codexQuery: null, codexCatalogTimeoutMs: null
    }, invoke), ...createCodexNativeOperations()],
    start() {
      unsubscribe ??= subscribeCodexDesktopDelivery(event => {
        options.host.publishManagerEvent('agent.delivery-receipt', { ...event, provider: 'codex' });
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
