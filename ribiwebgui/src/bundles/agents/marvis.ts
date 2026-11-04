import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "marvis", () => import("../../agentAdapters/MarvisAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      return params;
    }
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
