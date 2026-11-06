import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "antigravity", () => import("./agentAdapters/AntigravityAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("antigravityOffset", String(options.offset));
      if (options.limit != null) params.set("antigravityLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.antigravityConversationId || "").trim(), sessionName: String(route.antigravityConversationName || "").trim(), workspace: String(route.antigravityCwd || "").trim() }) }, new URL("./assets/antigravity.png", import.meta.url).href
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
