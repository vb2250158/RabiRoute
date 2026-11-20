import { CodexNativeHistoryReader, createCodexNativeOperations } from "../manager/providerNativeOperations.js";
import { CodexRemoteTaskOwner } from "./codexRemoteTask.js";
import type { CodexDesktopProgressMessage } from "../codexDesktopProgress.js";
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
  const historyReader = new CodexNativeHistoryReader();
  const remoteTasks = new CodexRemoteTaskOwner(options.host);
  let unsubscribe: (() => void) | undefined;
  return {
    operations: {
      "threads.history": (payload, invocation) => historyReader.read(payload.sessionId, {
        cursor: payload.cursor, limit: payload.limit, signal: invocation?.signal, maxBytes: 2 * 1024 * 1024,
        includeRecord: record => {
          const value = record as { type?: string; payload?: { type?: string; role?: string; phase?: string } } | null;
          const item = value?.payload;
          return value?.type === "event_msg" && (item?.type === "user_message" || item?.type === "task_complete")
            || value?.type === "response_item" && item?.type === "message"
              && (item.role === "user" || item.role === "assistant" && item.phase === "final_answer");
        }
      }),
      "threads.metadata": payload => readCodexDesktopThreadsByIds(payload.sessionIds).map(task => ({ id: task.id, title: task.title, url: codexDesktopDeepLinkForTest(task.id) })),
      "remote.task": (payload, invocation) => remoteTasks.execute(payload, invocation),
      "progress.observe": async (payload, invocation) => {
        const observe = invocation?.onProgress as ((message: CodexDesktopProgressMessage) => void) | undefined;
        if (!observe || signal.aborted || options.host.readOnly()) return;
        await runtime.watchCodexProgress(payload.threadId, payload.turnId, message => {
          if (!signal.aborted) observe(message);
        });
      },
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
