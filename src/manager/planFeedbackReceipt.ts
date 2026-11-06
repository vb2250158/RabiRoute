import type { AgentRequestStore } from "../agentRequests/store.js";
import { sameAgentEndpoint } from "../agentRequests/endpoint.js";

/** Feedback is sent by the Manager connection; resolve its original frozen receipt before a plan's current binding. */
export async function inspectOriginalPlanFeedbackReceipt(
  store: Pick<AgentRequestStore, "readCallerEndpointDelivery">,
  managerInstanceId: string,
  callerDeliveryId: string
): Promise<"accepted" | "in_progress" | undefined> {
  const original = await store.readCallerEndpointDelivery({ kind: "connection", transport: "local", managerInstanceId, id: managerInstanceId }, callerDeliveryId);
  if (!original) return undefined;
  if (original.state === "cancelled") throw new Error("Original plan feedback delivery was cancelled; preserve its receipt and do not replay it.");
  if (original.state !== "committed") return "in_progress";
  const receipt = original.receipt;
  if (!receipt?.accepted || receipt.deliveryId !== original.deliveryId || receipt.generation !== original.generation
    || receipt.promptHash !== original.promptHash || receipt.executionOptionsHash !== original.executionOptionsHash
    || !sameAgentEndpoint(receipt.endpoint, original.target)) throw new Error("Original plan feedback receipt is incomplete; do not infer acceptance from the current binding.");
  return "accepted";
}
