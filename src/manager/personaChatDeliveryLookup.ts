import type { AgentRequestStore } from "../agentRequests/store.js";
import type { ChatDeliveryParties } from "./personaChatTaskMetadata.js";

/** Read only committed metadata; never load prompt bodies or scan remote nodes. */
export function readChatDeliveryParties(store: Pick<AgentRequestStore, "getEndpointDelivery" | "list">, ids: string[]): Map<string, ChatDeliveryParties> {
  const found = new Map<string, ChatDeliveryParties>();
  const missing = new Set(ids);
  for (const id of ids) {
    try {
      const delivery = store.getEndpointDelivery(id);
      if (delivery) { found.set(id, delivery.preparation); missing.delete(id); }
    } catch { /* Isolate incomplete metadata to this delivery. */ }
  }
  if (missing.size) {
    try {
      // Older deliveries live in the existing in-memory request projection.
      for (const request of store.list()) {
        if (missing.has(request.deliveryId)) found.set(request.deliveryId, { source: request.source, target: request.target });
        if (request.response && missing.has(request.response.deliveryId)) found.set(request.response.deliveryId, { source: request.response.by, target: request.source });
        const pending = request.pendingResponseEvidence?.preparation;
        if (pending && missing.has(pending.deliveryId)) found.set(pending.deliveryId, pending);
      }
    } catch { /* Preserve endpoint results when legacy metadata is unavailable. */ }
  }
  return found;
}
