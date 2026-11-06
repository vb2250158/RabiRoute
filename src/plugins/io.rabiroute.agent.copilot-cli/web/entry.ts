import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "copilotCli", () => import("./agentAdapters/CopilotCliAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      return params;
    }, { warnings: (route, scan) => {
      const warnings = [...(scan?.warnings ?? [])];
      const selected = scan?.sessions?.find(session => session.name === route.copilotThreadName);
      const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (route.copilotCwd && route.copilotThreadName && selected?.projectPath && normalize(selected.projectPath) !== normalize(route.copilotCwd)) {
        warnings.push(`当前会话属于 ${selected.projectPath}，和工作目录不一致。`);
      }
      return [...new Set(warnings)];
    } }, new URL("./assets/copilot.svg", import.meta.url).href
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
