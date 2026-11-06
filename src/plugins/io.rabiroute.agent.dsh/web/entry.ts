import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "dsh", () => import("./agentAdapters/DshAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("dshOffset", String(options.offset));
      if (options.limit != null) params.set("dshLimit", String(options.limit));
      if (route.dshBaseUrl?.trim()) params.set("dshBaseUrl", route.dshBaseUrl.trim());
      return params;
    }, { session: route => ({ sessionId: String(route.dshSessionId || "").trim(), sessionName: String(route.dshSessionName || "").trim(), workspace: String(route.dshCwd || "").trim(), dshBaseUrl: String(route.dshBaseUrl || "").trim() || undefined }) }, new URL("./assets/dsh.png", import.meta.url).href
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
