import { parseAgentAdapterPackageDescriptor, type AgentAdapterDescriptor } from "@rabiroute/plugin-sdk";

export type AgentManagerDescriptor = Readonly<{
  type: string;
  capability: string;
  manifest: AgentAdapterDescriptor;
  sessionBinding: Readonly<{ sessionId?: string; sessionName?: string; workspace?: string; defaultName?: string }>;
}>;


/** Installed metadata and executable packages use the same SDK schema owner. */
export function parseAgentManagerDescriptor(value: unknown): AgentManagerDescriptor {
  return parseAgentAdapterPackageDescriptor(value);
}
