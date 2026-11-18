import { readWorkbuddyThread, sendWorkbuddyThreadMessage } from "../workbuddyThreads.js";
import { prepareWorkbuddyReplyText } from "../workbuddySessionBridge.js";
import { requestWorkbuddyDesktopSteer, WorkbuddyDesktopSteerNotSentError } from "../workbuddyDesktopRelay.js";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
import { readWorkbuddyHistory, workbuddyRecordConfirmsDelivery } from "../workbuddyHistory.js";
export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, _options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>) {
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
  if (workbuddyDeliveryMode === "steer") {
    await requestWorkbuddyDesktopSteer({
      threadId: endpoint.sessionId, workspace: thread.cwd, text: prepareWorkbuddyReplyText(delivery.prompt, imagePaths),
      deliveryId: delivery.deliveryId
    }, assertAuthorized).catch(error => {
      if (error instanceof WorkbuddyDesktopSteerNotSentError) throw new EndpointDeliveryNotSentError(error);
      throw error;
    });
    return { threadId: endpoint.sessionId, action: "steer_requested", transport: "workbuddy_desktop" };
  }
  return sendWorkbuddyThreadMessage({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd, assertAuthorized, imagePaths });
}

/** Recover a lost native acknowledgement from the original injected user record. */
export async function recoverSteerReceipt(delivery: NativeOwnerDeliveryEvidence,
  assertAuthorized: () => void | Promise<void>): Promise<EndpointDeliveryReceipt | undefined> {
  if (delivery.executionOptions?.workbuddyDeliveryMode !== "steer") return undefined;
  const { target, deliveryId, generation, promptHash, executionOptionsHash } = delivery;
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    await assertAuthorized();
    const history = await readWorkbuddyHistory(target.sessionId, { cursor });
    await assertAuthorized();
    if (history.entries.some(({ record }) => workbuddyRecordConfirmsDelivery(record, target.sessionId, deliveryId, true))) {
      return { deliveryId, generation, endpoint: target, promptHash, executionOptionsHash, accepted: true,
        action: "steered", transport: "workbuddy_desktop" };
    }
    if (!history.nextCursor) return undefined;
    cursor = history.nextCursor;
  }
}
