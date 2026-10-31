import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { endpointExecutionOptionsHash } from "./executionOptions.js";
import { agentDeliveryPromptHash } from "./store.js";
import type { AgentRequestEndpoint } from "./endpoint.js";
import { sameAgentEndpoint, normalizeAgentRequestEndpoint } from "./endpoint.js";
import { EndpointDeliveryNotSentError, validateEndpointDeliveryNoFrameProof, type EndpointDeliveryNoFrameProof } from "./deliveryFailure.js";

export type EndpointExecutionContext = {
  endpoint: AgentRequestEndpoint;
  assertAuthorized: () => void | Promise<void>;
  send: (delivery: PreparedEndpointDelivery, assertAuthorized: () => Promise<void>) => Promise<{ threadId: string; action: string; transport: string }>;
  readReceipt: (delivery: PreparedEndpointDelivery) => Promise<EndpointDeliveryReceipt | undefined>;
  writeReceipt: (delivery: PreparedEndpointDelivery, receipt: EndpointDeliveryReceipt) => Promise<void>;
  beginAttempt: (delivery: PreparedEndpointDelivery) => Promise<boolean>;
  readNotSent?: (delivery: PreparedEndpointDelivery) => Promise<EndpointDeliveryNoFrameProof | undefined>;
  writeNotSent?: (delivery: PreparedEndpointDelivery, proof: EndpointDeliveryNotSentError) => Promise<void>;
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
    const noFrameProof = await context.readNotSent?.(delivery);
    if (noFrameProof) {
      validateEndpointDeliveryNoFrameProof(delivery, noFrameProof);
      await assertAuthorized();
      throw new EndpointDeliveryNotSentError("Persisted transport owner evidence: no prompt frame was written by the original attempt.", noFrameProof);
    }
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
  if (!fresh) {
    const proof = await context.readNotSent?.(delivery);
    if (proof) {
      validateEndpointDeliveryNoFrameProof(delivery, proof);
      throw new EndpointDeliveryNotSentError("The original Manager attempt already has durable no-frame evidence.", proof);
    }
    return undefined;
  }
  let accepted: Awaited<ReturnType<EndpointExecutionContext["send"]>>;
  try { accepted = await context.send(delivery, assertAuthorized); }
  catch (error) {
    if (error instanceof EndpointDeliveryNotSentError) {
      // Returning to prepared is safe only after the transport owner has durably
      // recorded its proof. A failed evidence write keeps the attempt unknown.
      if (!context.writeNotSent) throw new Error("Transport cannot persist no-frame evidence; the original attempt remains unconfirmed.", { cause: error });
      await context.writeNotSent(delivery, error);
      const proof = await context.readNotSent?.(delivery);
      validateEndpointDeliveryNoFrameProof(delivery, proof);
      throw new EndpointDeliveryNotSentError(error, proof);
    }
    throw error;
  }
  await assertAuthorized();
  if (accepted.threadId !== delivery.target.sessionId) throw new Error("Owner accepted a different session; receipt is unconfirmed.");
  const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation,
    endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true,
    action: accepted.action, transport: accepted.transport };
  await context.writeReceipt(delivery, receipt);
  await assertAuthorized();
  return receipt;
}
