import { readDshSession, sendDshSessionMessage } from "../dshSessionBridge.js";
import type { EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import type { NativeOwnerDelivery } from "../agentRequests/nativeOwnerDelivery.js";
import type { AgentThreadRequestOptions } from "../agentThreads.js";
import { assertEndpointOwnerDirectory } from "../agentRequests/ownerExecution.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox, dshDeliveryMode } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);

    if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined) throw new Error("DSH owner protocol cannot apply model, reasoningEffort or sandbox.");
    const thread = await readDshSession(endpoint.sessionId, options.dshBaseUrl, assertAuthorized);
    await assertAuthorized();
    if (!thread || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact DSH owner is unavailable.");
    return sendDshSessionMessage({ sessionId: endpoint.sessionId, prompt: delivery.prompt, cwd, baseUrl: options.dshBaseUrl,
      requestId: delivery.deliveryId, mode: dshDeliveryMode, assertAuthorized });

}
