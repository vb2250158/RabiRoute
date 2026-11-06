import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "codex", () => import("../../agentAdapters/CodexAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("codexOffset", String(options.offset));
      if (options.limit != null) params.set("codexLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.codexThreadId || "").trim(), sessionName: String(route.codexThreadName || "").trim(), workspace: String(route.codexCwd || "").trim() }) }, new URL("../../assets/agents/codex.png", import.meta.url).href
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
