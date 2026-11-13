import { promptConfirmsDelivery, deliveryUserMessagesFromRollout } from "@rabiroute/host-api/shared/deliveryIdentity";
export { promptConfirmsDelivery } from "@rabiroute/host-api/shared/deliveryIdentity";
import { readCodexRolloutLines } from "../codexRolloutReader.js";

/** Point lookup in the exact task's accepted user messages, without a tail-size cutoff. */
export async function* readRolloutUserMessages(filePath: string, threadId = "", signal?: AbortSignal, deliveryId?: string): AsyncGenerator<string> {
  // These IDs need no JSON escaping. Any Unicode escape still requires decoding;
  // a matching ID may be encoded even when it is absent from the raw line.
  const literalId = deliveryId && /^[A-Za-z0-9_-]+$/.test(deliveryId) ? deliveryId : undefined;
  for await (const line of readCodexRolloutLines(filePath, threadId, { signal, requireTerminatedRecords: true, verifyIdentity: Boolean(threadId) })) {
    if (literalId && !line.includes(literalId) && !line.includes("\\u")) continue;
    for (const prompt of deliveryUserMessagesFromRollout(line)) yield prompt;
  }
}

export async function findRolloutDeliveryReceipt(filePath: string, deliveryId: string, threadId = "", signal?: AbortSignal): Promise<boolean> {
  if (!deliveryId) return false;
  for await (const prompt of readRolloutUserMessages(filePath, threadId, signal, deliveryId)) {
    if (promptConfirmsDelivery(prompt, deliveryId)) return true;
  }
  return false;
}
