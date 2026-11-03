import { registerMessageEndpointRenderer, type EndpointWebModuleApi } from "../../messageEndpoints/registerMessageEndpointRenderer";

export function activate(api: EndpointWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(
    api.forInstance(instanceId), "napcat", () => import("../../messageEndpoints/NapcatEndpointCard.vue")
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
