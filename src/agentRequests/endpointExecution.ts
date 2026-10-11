import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { endpointExecutionOptionsHash } from "./executionOptions.js";
import { agentDeliveryPromptHash } from "./store.js";
import type { AgentRequestEndpoint } from "./endpoint.js";
import { sameAgentEndpoint, normalizeAgentRequestEndpoint } from "./endpoint.js";

export type EndpointExecutionContext = {
  endpoint: AgentRequestEndpoint;
  assertAuthorized: () => void | Promise<void>;
  send: (delivery: PreparedEndpointDelivery, assertAuthorized: () => Promise<void>) => Promise<{ threadId: string; action: string; transport: string }>;
  readReceipt: (delivery: PreparedEndpointDelivery) => Promise<EndpointDeliveryReceipt | undefined>;
  writeReceipt: (delivery: PreparedEndpointDelivery, receipt: EndpointDeliveryReceipt) => Promise<void>;
  beginAttempt: (delivery: PreparedEndpointDelivery) => Promise<boolean>;
  recoverReceipt?: (delivery: PreparedEndpointDelivery, assertAuthorized: () => Promise<void>) => Promise<EndpointDeliveryReceipt | undefined>;
};

/** Connector stores transport receipts only, never prepares or owns business requests. */
export async function executePreparedEndpointDelivery(delivery: PreparedEndpointDelivery, context: EndpointExecutionContext,
  reconcile = false): Promise<EndpointDeliveryReceipt | undefined> {
  normalizeAgentRequestEndpoint(delivery.target);
  normalizeAgentRequestEndpoint(delivery.source);
  if (!["dispatching", "committed"].includes(delivery.state)
    || delivery.preparation.source.threadId !== delivery.source.sessionId
    || delivery.preparation.target.threadId !== delivery.target.sessionId
    || !sameAgentEndpoint(delivery.target, context.endpoint) || delivery.deliveryId !== delivery.preparation.deliveryId
    || !delivery.generation || delivery.promptHash !== agentDeliveryPromptHash(delivery.prompt)
    || delivery.executionOptionsHash !== endpointExecutionOptionsHash(delivery.executionOptions)
    || !sameAgentEndpoint(delivery.target, delivery.preparation.target.endpoint)
    || !sameAgentEndpoint(delivery.source, delivery.preparation.source.endpoint)) throw new Error("Prepared delivery identity or hash mismatch.");
  const assertAuthorized = async () => { await context.assertAuthorized(); };
  await assertAuthorized();
  const prior = await context.readReceipt(delivery);
  await assertAuthorized();
  if (prior) {
    const { validateEndpointReceipt } = await import("./endpointDelivery.js");
    validateEndpointReceipt(delivery, prior);
    return prior;
  }
  if (reconcile) {
    const recovered = await context.recoverReceipt?.(delivery, assertAuthorized);
    await assertAuthorized();
    if (recovered) {
      const { validateEndpointReceipt } = await import("./endpointDelivery.js");
      validateEndpointReceipt(delivery, recovered);
      // Reservation records recovered transport evidence only; reconciliation never calls send.
      await context.beginAttempt(delivery);
      await assertAuthorized();
      await context.writeReceipt(delivery, recovered);
      await assertAuthorized();
    }
    return recovered;
  }
  await assertAuthorized();
  const fresh = await context.beginAttempt(delivery);
  await assertAuthorized();
  if (!fresh) return undefined;
  const accepted = await context.send(delivery, assertAuthorized);
  await assertAuthorized();
  if (accepted.threadId !== delivery.target.sessionId) throw new Error("Owner accepted a different session; receipt is unconfirmed.");
  const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation,
    endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true,
    action: accepted.action, transport: accepted.transport };
  await context.writeReceipt(delivery, receipt);
  await assertAuthorized();
  return receipt;
}
