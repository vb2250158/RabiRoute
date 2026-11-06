import { readRolloutUserMessages } from "../agentRequests/rolloutReceipt.js";
import { agentDeliveryPromptHash } from "@rabiroute/host-api/agentRequests/store";
import { deliveryIdFromPrompt } from "@rabiroute/host-api/shared/deliveryIdentity";
import type { CodexNativeOperations } from "@rabiroute/host-api/agentAdapters/codexContracts";
import { CodexDesktopPromptNotSentError, codexDesktopLateStartAccepted, readCodexDesktopThread } from "../codexDesktopBridge.js";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
import { agentWorkspaceMismatch } from "@rabiroute/host-api/agentRequests/requestValidation";
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
  const { withoutLegacyTransportSuffix } = await import("@rabiroute/host-api/shared/deliveryIdentity");
  for await (const prompt of readRolloutUserMessages(owner.rolloutPath, owner.id, undefined, delivery.deliveryId)) {
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
  assertAuthorized: () => void | Promise<void>, transport: { sendCodex: CodexNativeOperations["sendCodexThreadMessage"] }) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);

    const thread = readCodexDesktopThread(endpoint.sessionId);
    if (!thread || thread.archived || !thread.cwd) throw new Error("Exact Codex owner is unavailable.");
    if (!sameCodexWorkspace(thread.cwd, cwd)) throw agentWorkspaceMismatch(endpoint);
    try {
      return await transport.sendCodex({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd,
        sandbox: sandbox ?? "workspace-write", model, reasoningEffort, assertAuthorized });
    } catch (error) {
      if (error instanceof CodexDesktopPromptNotSentError) throw new EndpointDeliveryNotSentError(error);
      throw error;
    }

}
