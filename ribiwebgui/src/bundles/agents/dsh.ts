import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "dsh", () => import("../../agentAdapters/DshAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("dshOffset", String(options.offset));
      if (options.limit != null) params.set("dshLimit", String(options.limit));
      if (route.dshBaseUrl?.trim()) params.set("dshBaseUrl", route.dshBaseUrl.trim());
      return params;
    }, { session: route => ({ sessionId: String(route.dshSessionId || "").trim(), sessionName: String(route.dshSessionName || "").trim(), workspace: String(route.dshCwd || "").trim(), dshBaseUrl: String(route.dshBaseUrl || "").trim() || undefined }) }
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
