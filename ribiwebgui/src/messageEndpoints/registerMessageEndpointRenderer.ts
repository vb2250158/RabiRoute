import type { AsyncComponentLoader } from "vue";
import type { TrustedWebSettingsRendererRegistration } from "../pluginRenderers";

type EndpointWebApi = Readonly<{
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
}>;

/** Each plugin supplies its own type and component; the Manager supplies its catalog metadata. */
export function registerMessageEndpointRenderer(api: EndpointWebApi, type: string, loader: AsyncComponentLoader): () => void {
  return api.registerSettingsRenderer({
    rendererId: `endpoint.${type}.card.v1`,
    placementId: "route.adapters.message-endpoint-settings",
    allowedSlots: [type],
    contributionKind: "message-endpoint-settings",
    contributionSurface: "route.adapters",
    schemaId: `endpoint.${type}.route.v1`,
    readCommandId: `endpoint.${type}.route.read`,
    writeCommandId: `endpoint.${type}.route.write`,
    loader
  });
}

export type EndpointWebModuleApi = Readonly<{
  instanceIds: readonly string[];
  forInstance(instanceId: string): EndpointWebApi;
}>;
