import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "workbuddy", () => import("../../agentAdapters/WorkbuddyAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("workbuddyOffset", String(options.offset));
      if (options.limit != null) params.set("workbuddyLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.workbuddySessionId || "").trim(), sessionName: String(route.workbuddySessionName || "").trim(), workspace: String(route.workbuddyCwd || "").trim() }) }, new URL("../../assets/agents/workbuddy.png", import.meta.url).href
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
