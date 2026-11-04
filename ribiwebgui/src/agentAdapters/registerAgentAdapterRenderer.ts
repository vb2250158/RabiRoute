import type { AsyncComponentLoader } from "vue";
import type { AgentRoutePresentation, TrustedWebSettingsRendererRegistration } from "../pluginRenderers";
import type { GatewayDefinition } from "../types";
import type { AgentCardScanOptions } from "./agentAdapterCardContext";

type AgentWebApi = Readonly<{
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
}>;
export type AgentWebModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): AgentWebApi }>;

export function registerAgentAdapterRenderer(api: AgentWebApi, type: string, loader: AsyncComponentLoader,
  agentScanQuery?: (route: GatewayDefinition, options: AgentCardScanOptions) => URLSearchParams, agentRoute?: AgentRoutePresentation): () => void {
  return api.registerSettingsRenderer({
    rendererId: `agent.${type}.card.v1`, placementId: "route.adapters.agent-settings", allowedSlots: [type],
    contributionKind: "agent-adapter-settings", contributionSurface: "route.adapters",
    schemaId: `agent.${type}.route.v1`, readCommandId: `agent.${type}.route.read`, writeCommandId: `agent.${type}.route.write`, loader, agentScanQuery, agentRoute
  });
}
