import { readWorkbuddyThread, sendWorkbuddyThreadMessage } from "../workbuddyThreads.js";
import { prepareWorkbuddyReplyText } from "../workbuddySessionBridge.js";
import { requestWorkbuddyDesktopMessage, WorkbuddyDesktopMessageNotSentError } from "../workbuddyDesktopRelay.js";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
import { hasRecentWorkbuddyDelivery, readWorkbuddyHistory, workbuddyRecordConfirmsDelivery } from "../workbuddyHistory.js";
export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, _options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>, ensureDesktopReady?: () => Promise<void>) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox, dshDeliveryMode, workbuddyDeliveryMode, localImages } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);

  if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined || dshDeliveryMode !== undefined) {
    throw new Error("WorkBuddy owner protocol cannot apply model, reasoningEffort, sandbox or dshDeliveryMode.");
  }
  const thread = readWorkbuddyThread(endpoint.sessionId) as { cwd?: string; archived?: boolean };
  if (!thread?.cwd || thread.archived || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact WorkBuddy owner is unavailable.");
  const imagePaths = localImages?.map(image => image.path);
  const dispatchDesktop = async (mode: "steer" | "continue") => {
    try {
      await requestWorkbuddyDesktopMessage({
        threadId: endpoint.sessionId, workspace: cwd, text: prepareWorkbuddyReplyText(delivery.prompt, imagePaths),
        deliveryId: delivery.deliveryId
      }, mode, assertAuthorized);
    } catch (error) {
      if (error instanceof WorkbuddyDesktopMessageNotSentError) throw new EndpointDeliveryNotSentError(error);
      throw error;
    }
  };
  if (workbuddyDeliveryMode === "steer") {
    await dispatchDesktop("steer");
    return { threadId: endpoint.sessionId, action: "steer_requested", transport: "workbuddy_desktop" };
  }
  return sendWorkbuddyThreadMessage({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd, assertAuthorized, imagePaths,
    continueUnloaded: ensureDesktopReady && (async () => {
      await assertAuthorized();
      try { await ensureDesktopReady(); }
      catch (error) { throw new EndpointDeliveryNotSentError(error); }
      await dispatchDesktop("continue");
    })
  });
}

function missingNativeTranscript(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
  throw error;
}

/** Recover a lost acknowledgement from the original native user record. */
export async function recoverWorkbuddyDeliveryReceipt(delivery: NativeOwnerDeliveryEvidence,
  assertAuthorized: () => void | Promise<void>): Promise<EndpointDeliveryReceipt | undefined> {
  if (delivery.target.provider !== "workbuddy" || !delivery.executionOptions) return undefined;
  const steer = delivery.executionOptions.workbuddyDeliveryMode === "steer";
  const { target, deliveryId, generation, promptHash, executionOptionsHash } = delivery;
  const receipt: EndpointDeliveryReceipt = { deliveryId, generation, endpoint: target, promptHash, executionOptionsHash, accepted: true,
    action: steer ? "steered" : "started", transport: "workbuddy_native_history" };
  await assertAuthorized();
  const recent = await hasRecentWorkbuddyDelivery(target.sessionId, deliveryId, steer).catch(missingNativeTranscript);
  await assertAuthorized();
  if (recent === undefined) return undefined;
  if (recent) return receipt;
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    await assertAuthorized();
    const history = await readWorkbuddyHistory(target.sessionId, { cursor }).catch(missingNativeTranscript);
    await assertAuthorized();
    if (!history) return undefined;
    if (history.entries.some(({ record }) => workbuddyRecordConfirmsDelivery(record, target.sessionId, deliveryId, steer))) {
      return receipt;
    }
    if (!history.nextCursor) return undefined;
    cursor = history.nextCursor;
  }
}
