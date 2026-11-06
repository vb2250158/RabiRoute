import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "workbuddy", () => import("./agentAdapters/WorkbuddyAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("workbuddyOffset", String(options.offset));
      if (options.limit != null) params.set("workbuddyLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.workbuddySessionId || "").trim(), sessionName: String(route.workbuddySessionName || "").trim(), workspace: String(route.workbuddyCwd || "").trim() }) }, new URL("./assets/workbuddy.png", import.meta.url).href
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
