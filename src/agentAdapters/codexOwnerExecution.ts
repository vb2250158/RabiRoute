import { readRolloutUserMessages } from "../agentRequests/rolloutReceipt.js";
import { agentDeliveryPromptHash } from "../agentRequests/store.js";
import { deliveryIdFromPrompt } from "../shared/deliveryIdentity.js";
import { sendCodexThreadMessage } from "../codexRuntime.js";
import { CodexDesktopPromptNotSentError, codexDesktopLateStartAccepted, readCodexDesktopThread } from "../codexDesktopBridge.js";
import { EndpointDeliveryNotSentError } from "../agentRequests/deliveryFailure.js";
import type { EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "../agentRequests/nativeOwnerDelivery.js";
import type { AgentThreadRequestOptions } from "../agentThreads.js";
import { assertEndpointOwnerDirectory } from "../agentRequests/ownerExecution.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
export async function recoverEndpointOwnerReceipt(delivery: NativeOwnerDeliveryEvidence, assertAuthorized: () => void | Promise<void>): Promise<EndpointDeliveryReceipt | undefined> {
  await assertAuthorized();
  if (delivery.target.provider !== "codex") return undefined;
  if (codexDesktopLateStartAccepted(delivery.target.sessionId, delivery.deliveryId)) {
    await assertAuthorized();
    return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      accepted: true, action: "receipt_recovered", transport: "desktop-ipc" };
  }
  const owner = readCodexDesktopThread(delivery.target.sessionId);
  if (!owner || !owner.rolloutPath) return undefined;
  await assertAuthorized();
  const { withoutLegacyTransportSuffix } = await import("../shared/deliveryIdentity.js");
  for await (const prompt of readRolloutUserMessages(owner.rolloutPath)) {
    const prefix = withoutLegacyTransportSuffix(prompt);
    // Historical Desktop transports added a UUID after the frozen Manager envelope.
    // Recovery still requires the original structured identity and exact reserved bytes.
    const exactEvidence = deliveryIdFromPrompt(prompt) === delivery.deliveryId && agentDeliveryPromptHash(prompt) === delivery.promptHash
      || (prefix !== undefined && deliveryIdFromPrompt(prefix) === delivery.deliveryId && agentDeliveryPromptHash(prefix) === delivery.promptHash);
    if (exactEvidence) {
      // Historical messages are local evidence, not separate execution steps.
      // Recheck the current grant before accepting evidence, without a remote
      // authority round trip for every unrelated message in a long rollout.
      await assertAuthorized();
      return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
        accepted: true, action: "receipt_recovered", transport: "desktop-ipc" };
    }
  }
  await assertAuthorized();
  return undefined;
}

export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, _options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>, transport: { sendCodex: typeof sendCodexThreadMessage } = { sendCodex: sendCodexThreadMessage }) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);

    const thread = readCodexDesktopThread(endpoint.sessionId);
    if (!thread || thread.archived || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact Codex owner is unavailable.");
    try {
      return await transport.sendCodex({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd,
        sandbox: sandbox ?? "workspace-write", model, reasoningEffort, assertAuthorized });
    } catch (error) {
      if (error instanceof CodexDesktopPromptNotSentError) throw new EndpointDeliveryNotSentError(error);
      throw error;
    }

}
