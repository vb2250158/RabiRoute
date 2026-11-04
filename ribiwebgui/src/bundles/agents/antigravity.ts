import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "antigravity", () => import("../../agentAdapters/AntigravityAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("antigravityOffset", String(options.offset));
      if (options.limit != null) params.set("antigravityLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.antigravityConversationId || "").trim(), sessionName: String(route.antigravityConversationName || "").trim(), workspace: String(route.antigravityCwd || "").trim() }) }
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
