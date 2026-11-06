import { readDshSession, sendDshSessionMessage } from "../dshSessionBridge.js";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import type { NativeOwnerDelivery } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
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
