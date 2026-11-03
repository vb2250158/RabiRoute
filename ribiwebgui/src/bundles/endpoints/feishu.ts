import { registerMessageEndpointRenderer, type EndpointWebModuleApi } from "../../messageEndpoints/registerMessageEndpointRenderer";

export function activate(api: EndpointWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(
    api.forInstance(instanceId), "feishu", () => import("../../messageEndpoints/FeishuEndpointCard.vue")
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
