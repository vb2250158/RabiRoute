import type { AgentAdapterManifest, AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import type { RabiDeliveryEnvelope } from "../shared/rabiMessage.js";

export type AgentDeliveryOptions = {
  imagePaths?: string[];
};

export type AgentAdapter = {
  type: AgentAdapterType;
  deliver(envelope: RabiDeliveryEnvelope, options?: AgentDeliveryOptions): Promise<void>;
};

export type AgentAdapterDefinition = {
  manifest: AgentAdapterManifest;
  create(): AgentAdapter;
};
