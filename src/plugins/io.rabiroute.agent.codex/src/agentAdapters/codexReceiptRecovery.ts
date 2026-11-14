import {readRolloutUserMessages} from '../agentRequests/rolloutReceipt.js';
import {readCodexDesktopThread} from '../codexDesktopBridge.js';
import {recoverAgentResponseDelivery} from '@rabiroute/host-api/agentRequests/deliveryRecovery';
import {agentDeliveryPromptHash,type AgentRequestStore} from '@rabiroute/host-api/agentRequests/store';
export async function recoverAgentResponseDeliveryFromRollout(
  store: AgentRequestStore,
  threadId: string,
  deliveryId: string
): Promise<Awaited<ReturnType<typeof recoverAgentResponseDelivery>>> {
  const initial = await recoverAgentResponseDelivery(store, threadId, deliveryId, () => []);
  if (initial.status !== "delivery_unconfirmed") return initial;
  const thread = readCodexDesktopThread(threadId);
  if (!thread?.rolloutPath) return { ...initial, status: "receipt_source_missing" };
  const evidenceHash = initial.inReplyToRequestId
    ? store.get(initial.inReplyToRequestId)?.pendingResponseEvidence?.promptHash : undefined;
  try {
    for await (const prompt of readRolloutUserMessages(thread.rolloutPath, thread.id)) {
      if (!prompt.includes(deliveryId) && agentDeliveryPromptHash(prompt) !== evidenceHash) continue;
      const result = await recoverAgentResponseDelivery(store, threadId, deliveryId, () => [prompt]);
      if (result.status !== "delivery_unconfirmed") return result;
    }
  } catch (error) {
    throw new Error(`Reply receipt recovery could not complete: ${(error as NodeJS.ErrnoException).code || (error as Error).name || "recovery_failed"}. Keep the original deliveryId and verify task-record access and request-storage persistence before retrying recovery.`);
  }
  return initial;
}
