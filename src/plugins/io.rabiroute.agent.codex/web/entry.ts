import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerAgentAdapterRenderer, type AgentWebModuleApi } from "../../../../ribiwebgui/src/agentAdapters/registerAgentAdapterRenderer";

export function activate(api: AgentWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerAgentAdapterRenderer(
    api.forInstance(instanceId), "codex", () => import("./agentAdapters/CodexAgentCard.vue"), (route, options) => {
      const params = new URLSearchParams();
      if (options.offset != null) params.set("codexOffset", String(options.offset));
      if (options.limit != null) params.set("codexLimit", String(options.limit));
      return params;
    }, { session: route => ({ sessionId: String(route.codexThreadId || "").trim(), sessionName: String(route.codexThreadName || "").trim(), workspace: String(route.codexCwd || "").trim() }) }, new URL("./assets/codex.png", import.meta.url).href
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
