import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi): () => void {
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "astrbot", () => import("../../agentAdapters/AstrbotAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      return params;
    }, { warnings: (route, scan) => {
      const hasLocalPassword = Boolean(route.astrbotPassword?.trim());
      const pluginReady = scan?.plugins?.every(plugin => plugin.installed) ?? false;
      const endpointReady = scan?.endpoints?.some(endpoint => endpoint.healthy) ?? false;
      return [...new Set((scan?.warnings ?? []).filter(warning => {
        if (hasLocalPassword && warning.includes("缺少 AstrBot 密码")) return false;
        if (warning.includes("默认管线") || warning.includes("无可选会话列表")) return false;
        if (hasLocalPassword && pluginReady && endpointReady && warning.includes("尚未验证列会话")) return false;
        return true;
      }))];
    } }, new URL("../../assets/agents/astrbot.svg", import.meta.url).href
  ));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
