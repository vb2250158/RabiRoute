import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "grokBot", () => import("../../agentAdapters/GrokBotAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("grokBotOffset", String(options.offset));
      if (options.limit != null) params.set("grokBotLimit", String(options.limit));
      if (route.grokBotAgentId) params.set("grokBotAgentId", route.grokBotAgentId);
      return params;
    }
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
