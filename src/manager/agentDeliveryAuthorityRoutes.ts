import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { sameAgentEndpoint } from "../agentRequests/endpoint.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";

export type AgentDeliveryAuthorityContext = {
  store: AgentRequestStore;
  authorize: (endpoint: AgentRequestEndpoint, role?: "source" | "target") => void;
  refreshEndpoints?: (identities: Pick<PreparedEndpointDelivery, "source" | "target">) => Promise<void>;
  assertRequestAuthority?: () => void;
  managerInstanceId?: string;
  jsonResponse: (response: ServerResponse, statusCode: number, body: unknown) => void;
};

/** Proof of an existing exact reservation only; never creates a grant or reveals the prompt. */
export async function handleAgentDeliveryAuthority(request: IncomingMessage, url: URL,
  response: ServerResponse, context: AgentDeliveryAuthorityContext): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/agent/delivery-authority") return false;
  response.setHeader("cache-control", "no-store");
  try {
    context.assertRequestAuthority?.();
    assertTrustedLanAgentPrincipal(request);
    const deliveryId = url.searchParams.get("deliveryId");
    const generation = url.searchParams.get("generation");
    if (!deliveryId || deliveryId.length > 100 || !generation || generation.length > 100
      || url.searchParams.getAll("deliveryId").length !== 1 || url.searchParams.getAll("generation").length !== 1) {
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
      context.assertRequestAuthority?.();
      context.authorize(delivery.source, "source");
      context.authorize(delivery.target, "target");
    }
    assertTrustedLanAgentPrincipal(request);
    context.assertRequestAuthority?.();
    if (terminal) {
      const current = context.store.getEndpointDelivery(deliveryId);
      if (!current || current.state !== "cancelled" || current.generation !== delivery.generation
        || current.promptHash !== delivery.promptHash || current.executionOptionsHash !== delivery.executionOptionsHash
        || !sameAgentEndpoint(current.source, delivery.source) || !sameAgentEndpoint(current.target, delivery.target)) {
        throw new Error("Original terminal reservation changed.");
      }
    } else context.store.assertEndpointDeliveryActive(deliveryId);
    context.jsonResponse(response, 200, { code: 0, data: { authorized: !terminal,
      deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      ledgerManagerInstanceId, source: delivery.source, endpoint: delivery.target, preparation: delivery.preparation, state: delivery.state } });
  } catch {
    context.jsonResponse(response, 403, { code: -1, error: "DELIVERY_AUTHORITY_UNAVAILABLE", authorized: false });
  }
  return true;
}
