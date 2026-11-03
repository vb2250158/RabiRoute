import type { AgentRequestEndpoint } from "./endpoint.js";
import type { EndpointExecutionOptions } from "./executionOptions.js";

/** Exact native execution transport; this carries no Agent source or business intent. */
export type NativeOwnerDelivery = {
  deliveryId: string;
  generation: string;
  target: AgentRequestEndpoint;
  prompt: string;
  promptHash: string;
  executionOptionsHash: string;
  executionOptions: EndpointExecutionOptions;
  dispatchAttemptId?: string;
};
export type NativeOwnerDeliveryEvidence = Pick<NativeOwnerDelivery,
  "deliveryId" | "generation" | "target" | "promptHash" | "executionOptionsHash" | "dispatchAttemptId"> & Partial<Pick<NativeOwnerDelivery, "executionOptions">>;
