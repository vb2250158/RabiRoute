import type { PeerAgentEndpointBridge } from "@rabiroute/host-api/manager/peerAgentEndpointBridge";
import type { PreparedEndpointDelivery } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";

/** Receiver records execution evidence only; the originating Manager keeps the business reservation. */
export function createPeerAgentOperations(owner: PeerAgentEndpointBridge): readonly ApiOperationDefinition[] {
  return [false, true].map(reconcile => {
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const execute = owner.prepareExecution(input.request, input.signal);
      return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
        try {
          const receipt = await execute(parsed.body as { ledgerOwnerDeviceId: string; delivery: PreparedEndpointDelivery }, reconcile);
          return { status: 200, body: { code: 0, ...(receipt ? { receipt } : {}) } };
        } catch (error) {
          if (error instanceof EndpointDeliveryNotSentError && error.proof) return { status: 200, body: { code: 0, notSent: error.proof } };
          throw error;
        }
      };
    };
    return { contract: {
      operationId: `manager.agent.prepared-deliveries.${reconcile ? "reconcile" : "execute"}`, contractVersion: "1.0.0", method: "POST",
      pathTemplate: "/api/agent/prepared-deliveries" + (reconcile ? "/reconcile" : ""), exposure: "public", transport: "http",
      description: "Execute or read the original cross-PC prepared delivery on its exact native task owner; never create another business request.",
      request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "json", maxBytes: 0,
        schema: { type: "object", required: ["ledgerOwnerDeviceId", "delivery"], properties: { ledgerOwnerDeviceId: { type: "string" }, delivery: { type: "object" } } } } },
      responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code"], properties: { code: { const: 0 }, receipt: { type: "object" }, notSent: { type: "object" } } } } },
      effects: { mode: reconcile ? "read-original-execution" : "execute-original-reservation", description: "Only native execution receipts are stored here. The originating AgentRequestStore remains the sole business ledger." },
      recovery: { strategy: "original-delivery-receipt", description: "Use the same delivery, generation, target and hashes. Reconciliation never sends. An unknown attempt must not be replayed." },
      validators: [{ id: "existing-peer-owner", description: "The existing Manager admission supplies the original source PC. Body addresses do not grant trust; preserve that admission across target-owner reads and execution." },
        { id: "native-prepared-execution", description: "The shared prepared executor validates exact target, original preparation, hashes and durable attempt receipts. No Agent registration or extra feature authorization is required." }]
    }, prepare, handler: input => prepare(input)(input) };
  });
}
