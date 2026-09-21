import type { AgentSendRequest } from "../agentSend.js";
import type { ValidatedMessageProcessingSendContext } from "../messageProcessing/sendContextReview.js";
import type { AgentSendReceipt } from "./agentSendIdempotency.js";

type Dependencies = {
  readReceipt: (deliveryId: string) => AgentSendReceipt | null;
  authorize: (request: AgentSendRequest, receipt: AgentSendReceipt | null) => void;
  validate: (request: AgentSendRequest) => Promise<ValidatedMessageProcessingSendContext | undefined>;
};

export type ReviewedAgentSendGate = {
  request: AgentSendRequest;
  receipt: AgentSendReceipt | null;
  context?: ValidatedMessageProcessingSendContext;
  replayOnly: boolean;
};

function freezeRequest<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeRequest(item);
  }
  return value;
}

function completed(receipt: AgentSendReceipt): boolean {
  return receipt.state === "completed" && receipt.result !== undefined;
}

/** Validation is not a delivery owner. Only the existing idempotency service may replay or send. */
export async function resolveReviewedAgentSendGate(request: AgentSendRequest, dependencies: Dependencies): Promise<ReviewedAgentSendGate> {
  const snapshot = freezeRequest(structuredClone(request));
  const deliveryId = String(snapshot.deliveryId || "");
  const initial = dependencies.readReceipt(deliveryId);
  dependencies.authorize(snapshot, initial);
  if (initial) {
    if (!completed(initial)) throw new Error(`The delivery receipt is ${initial.state}; context validation cannot authorize a retry.`);
    return { request: snapshot, receipt: initial, replayOnly: true };
  }
  let context: ValidatedMessageProcessingSendContext | undefined;
  let validationFailed = false;
  let validationError: unknown;
  try { context = await dependencies.validate(snapshot); }
  catch (error) { validationFailed = true; validationError = error; }
  let current: AgentSendReceipt | null;
  try { current = dependencies.readReceipt(deliveryId); }
  catch (error) {
    if (validationFailed) throw new AggregateError([validationError, error], "Cannot confirm the delivery receipt after context validation.", { cause: validationError });
    throw error;
  }
  if (current) {
    if (completed(current)) return { request: snapshot, receipt: current, replayOnly: true };
    if (validationFailed) throw validationError;
    throw new Error(`The delivery receipt is ${current.state}; context validation cannot authorize a retry.`);
  }
  if (validationFailed) throw validationError;
  // Policy may have changed while the bounded reader was running.
  dependencies.authorize(snapshot, null);
  return { request: snapshot, receipt: null, context: freezeRequest(context), replayOnly: false };
}

export function assertReviewedAgentSendMayDeliver(gate: ReviewedAgentSendGate): void {
  if (gate.replayOnly) throw new Error("The completed receipt changed before replay; refusing a new delivery.");
}
