import { registerMessageEndpointRenderer } from "../../messageEndpoints/registerMessageEndpointRenderer";
type EndpointApi = Parameters<typeof registerMessageEndpointRenderer>[0];
export function activate(api: { instanceIds: readonly string[]; forInstance(instanceId: string): EndpointApi }): () => void {
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(api.forInstance(instanceId), "speech", () => import("../../messageEndpoints/SpeechEndpointCard.vue")));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
