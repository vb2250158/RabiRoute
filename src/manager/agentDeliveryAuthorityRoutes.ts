import type { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { sameAgentEndpoint } from "../agentRequests/endpoint.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";

export type AgentDeliveryAuthorityContext = {
  store: AgentRequestStore;
  authorize: (endpoint: AgentRequestEndpoint, role?: "source" | "target") => void;
  refreshEndpoints?: (identities: Pick<PreparedEndpointDelivery, "source" | "target">) => Promise<void>;
  assertRequestAuthority?: () => void;
  managerInstanceId?: string;
};

/** Native reservation proof; no HTTP routing, prompt disclosure or new grant. */
export async function readAgentDeliveryAuthority(identity: Readonly<{ deliveryId: unknown; generation: unknown }>, context: AgentDeliveryAuthorityContext,
  assertCurrent: () => void): Promise<import("./apiOperationContract.js").ApiOperationResult> {
  const guard = () => { context.assertRequestAuthority?.(); assertCurrent(); };
  try {
    guard();
    const { deliveryId, generation } = identity;
    if (typeof deliveryId !== "string" || !deliveryId || deliveryId.length > 100
      || typeof generation !== "string" || !generation || generation.length > 100) {
      throw new Error("Invalid delivery authority identity.");
    }
    const delivery = context.store.getEndpointDelivery(deliveryId);
    if (!delivery || delivery.generation !== generation || !["dispatching", "committed", "cancelled"].includes(delivery.state)) {
      throw new Error("Original delivery reservation is unavailable.");
    }
    const ledgerManagerInstanceId = context.managerInstanceId ?? delivery.source.managerInstanceId;
    if (delivery.source.managerInstanceId !== ledgerManagerInstanceId || delivery.target.managerInstanceId !== ledgerManagerInstanceId) {
      throw new Error("Delivery belongs to another ledger authority.");
    }
    const terminal = delivery.state === "cancelled";
    if (!terminal) {
      context.store.assertEndpointDeliveryActive(deliveryId);
      await context.refreshEndpoints?.({ source: Object.freeze({ ...delivery.source }), target: Object.freeze({ ...delivery.target }) });
      guard();
      context.authorize(delivery.source, "source");
      context.authorize(delivery.target, "target");
    }
    guard();
    if (terminal) {
      const current = context.store.getEndpointDelivery(deliveryId);
      if (!current || current.state !== "cancelled" || current.generation !== delivery.generation
        || current.promptHash !== delivery.promptHash || current.executionOptionsHash !== delivery.executionOptionsHash
        || !sameAgentEndpoint(current.source, delivery.source) || !sameAgentEndpoint(current.target, delivery.target)) {
        throw new Error("Original terminal reservation changed.");
      }
    } else context.store.assertEndpointDeliveryActive(deliveryId);
    return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data: { authorized: !terminal,
      deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      ledgerManagerInstanceId, source: delivery.source, endpoint: delivery.target, preparation: delivery.preparation, state: delivery.state } } };
  } catch {
    return { status: 403, headers: { "cache-control": "no-store" }, body: { code: -1, error: "DELIVERY_AUTHORITY_UNAVAILABLE", authorized: false } };
  }
}
