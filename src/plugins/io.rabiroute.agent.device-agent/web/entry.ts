import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "deviceAgent", () => import("./agentAdapters/DeviceAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      return params;
    }
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
