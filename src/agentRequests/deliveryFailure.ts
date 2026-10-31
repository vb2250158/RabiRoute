import type { PreparedEndpointDelivery } from "./endpointDelivery.js";
import { sameAgentEndpoint, type AgentRequestEndpoint } from "./endpoint.js";

/** Authenticated execution owner evidence for one exact durable transport attempt. */
export type EndpointDeliveryNoFrameProof = {
  kind: "no-prompt-frame";
  deliveryId: string;
  generation: string;
  promptHash: string;
  executionOptionsHash: string;
  dispatchAttemptId: string;
  endpoint: AgentRequestEndpoint;
  attemptId: string;
  attemptSequence: number;
  observedAt: string;
};

export function validateEndpointDeliveryNoFrameProof(delivery: PreparedEndpointDelivery, input: unknown): asserts input is EndpointDeliveryNoFrameProof {
  const proof = input as Partial<EndpointDeliveryNoFrameProof> | null;
  if (!proof || proof.kind !== "no-prompt-frame" || proof.deliveryId !== delivery.deliveryId || proof.generation !== delivery.generation
    || proof.promptHash !== delivery.promptHash || proof.executionOptionsHash !== delivery.executionOptionsHash
    || !delivery.dispatchAttemptId || proof.dispatchAttemptId !== delivery.dispatchAttemptId
    || !sameAgentEndpoint(proof.endpoint, delivery.target)
    || typeof proof.attemptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(proof.attemptId)
    || !Number.isSafeInteger(proof.attemptSequence) || proof.attemptSequence! < 1 || !Number.isFinite(Date.parse(proof.observedAt ?? ""))) {
    throw new Error("Transport no-frame proof does not match the exact original delivery and attempt.");
  }
}

/** Positive transport-owner proof: no prompt frame crossed this attempt's execution boundary. */
export class EndpointDeliveryNotSentError extends Error {
  readonly code = "DELIVERY_NOT_SENT";
  readonly role = "target";
  readonly proof?: EndpointDeliveryNoFrameProof;
  constructor(cause: unknown, proof?: EndpointDeliveryNoFrameProof) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "EndpointDeliveryNotSentError";
    if (proof) this.proof = structuredClone(proof);
  }
}
