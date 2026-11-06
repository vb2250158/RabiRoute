import { readWorkbuddyThread, sendWorkbuddyThreadMessage } from "../workbuddyThreads.js";
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

    if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined || dshDeliveryMode !== undefined) throw new Error("WorkBuddy owner protocol cannot apply model, reasoningEffort, sandbox or dshDeliveryMode.");
    const thread = readWorkbuddyThread(endpoint.sessionId) as { cwd?: string };
    if (!thread || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact WorkBuddy owner is unavailable.");
    return sendWorkbuddyThreadMessage({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd, assertAuthorized });

}
