import path from 'node:path';
import * as endpointOwner from "./workbuddyOwnerExecution.js";
import * as threads from '../workbuddyThreads.js';
import { readWorkbuddyHistory, workbuddyRecordConfirmsDelivery } from '../workbuddyHistory.js';
import { readWorkbuddyDesktopIntent } from '../workbuddyDesktopCreation.js';
import { requestWorkbuddyDesktopCreation } from '../workbuddyDesktopRelay.js';
import { createWorkbuddyDesktopBootstrap } from '../workbuddyDesktopBootstrap.js';
import { legacyWorkbuddyDesktopLayout, type WorkbuddyDesktopLayout } from '../workbuddyDesktopLayout.js';
import { workbuddyHomeDir } from '../workbuddySessionStore.js';
import { updateHooks } from './workbuddyHookInstallation.js';
import type { AgentInitialThreadCreationInput, AgentThreadDeliveryObservation } from '@rabiroute/host-api/agentThreads';
import { commonManagerOperations, nativeOperations, createAgentScanOperations, type AgentOwnedManager } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import type { AgentManagerImplementationOptions } from '@rabiroute/host-api/manager/agentManagerHostPorts';
import type { AgentManagerDescriptor } from '@rabiroute/host-api/manager/agentManagerProviders';

// This package selects the WorkBuddy UI layout for new submissions. The running
// connector retains only the layout protocol and a compatibility default.
const desktopLayout: WorkbuddyDesktopLayout = Object.freeze({ ...legacyWorkbuddyDesktopLayout });

/** An accepted gateway request is visible only once its user message reaches this native history. */
function observeWorkbuddyDelivery(
  history: NonNullable<Awaited<ReturnType<typeof readWorkbuddyHistory>>>, threadId: string, deliveryId: string
): AgentThreadDeliveryObservation {
  if (history.source !== "workbuddy-native-transcript" || history.sessionId !== threadId) {
    throw new Error("WorkBuddy native history does not belong to the requested task.");
  }
  const observed = history.entries.find(({ record }) => workbuddyRecordConfirmsDelivery(record, threadId, deliveryId));
  return {
    deliveryId, state: observed ? "accepted" : "not_observed", source: history.source, retryable: false,
    ...(observed ? { sequence: observed.sequence } : { nextCursor: history.nextCursor })
  };
}

export function createManager(options: AgentManagerImplementationOptions, descriptor: AgentManagerDescriptor, signal: AbortSignal): AgentOwnedManager {
  const ensureDesktopReady = createWorkbuddyDesktopBootstrap({
    scannerEntry: options.scannerEntry,
    applicationRoot: options.host.packageRoot
  });
  return {
    operations: {
      "threads.list": (payload: Parameters<typeof threads.listWorkbuddyThreads>[0]) => threads.listWorkbuddyThreads(payload),
      "threads.read": ({ threadId }: { threadId: string }) => threads.readWorkbuddyThread(threadId),
      "threads.send": async (payload: Parameters<typeof threads.sendWorkbuddyThreadMessage>[0], invocation) => ({
        ...await threads.sendWorkbuddyThreadMessage({ ...payload, assertAuthorized: invocation?.assertCurrent }),
        acceptedBy: "workbuddy_session_owner"
      }),
      "threads.create": async (payload: AgentInitialThreadCreationInput, invocation) => {
        invocation?.assertCurrent?.();
        if (options.host.readOnly()) throw new Error("Manager is read-only.");
        const requestSignal = invocation?.signal;
        const input = { ...payload, workspaceLabel: path.win32.basename(payload.workspace), layout: desktopLayout };
        const existing = await readWorkbuddyDesktopIntent(input, path.join(workbuddyHomeDir(), "rabiroute-desktop-intents"), requestSignal);
        invocation?.assertCurrent?.();
        if (existing) return existing;
        await ensureDesktopReady(requestSignal, invocation?.assertCurrent);
        invocation?.assertCurrent?.();
        return requestWorkbuddyDesktopCreation(input, requestSignal);
      },
      "threads.history": (payload, invocation) => readWorkbuddyHistory(payload.sessionId, {
        cursor: payload.cursor, limit: payload.limit, signal: invocation?.signal,
        assertAuthorized: invocation?.assertCurrent
      }),
      "threads.observeDelivery": async ({ threadId, deliveryId, cursor, limit }, invocation) => {
        const history = await readWorkbuddyHistory(threadId, { cursor, limit, signal: invocation?.signal, assertAuthorized: invocation?.assertCurrent });
        return { history, delivery: observeWorkbuddyDelivery(history, threadId, deliveryId) };
      },
      "endpoint.execute": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Pick<Parameters<typeof endpointOwner.executeEndpointOnOwner>, 0 | 1 | 2> | undefined;
        if (!args) throw new Error("Original native endpoint arguments are required.");
        return endpointOwner.executeEndpointOnOwner(args[0], args[1], args[2],
          () => ensureDesktopReady(invocation?.signal, invocation?.assertCurrent));
      },
      ...commonManagerOperations(options, descriptor, signal, {
        workbuddyEndpoint: 'workbuddyEndpoint'
      }),
      "endpoint.recover": (_payload, invocation) => {
        const args = invocation?.nativeArgs as Parameters<typeof endpointOwner.recoverWorkbuddyDeliveryReceipt> | undefined;
        return args ? endpointOwner.recoverWorkbuddyDeliveryReceipt(...args) : undefined;
      },
      ...nativeOperations({
        listWorkbuddyThreads: threads.listWorkbuddyThreads, readWorkbuddyThread: threads.readWorkbuddyThread, sendWorkbuddyThreadMessage: threads.sendWorkbuddyThreadMessage
      }), 'hooks.update': (_payload, invocation) => updateHooks(options.host.packageRoot, undefined, {
        signal: invocation?.signal
      })
    }, apiOperations: invoke => createAgentScanOperations(descriptor.type, {
      workbuddyLimit: 200, workbuddyOffset: 0, workbuddyQuery: null, workbuddyWorkspace: null
    }, invoke)
  };
}
