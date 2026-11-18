import { registerMessageEndpointRenderer, type EndpointWebModuleApi } from "../../../../ribiwebgui/src/messageEndpoints/registerMessageEndpointRenderer";
import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";

export function activate(api: EndpointWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(id => registerMessageEndpointRenderer(
    api.forInstance(id), "qqbot", () => import("./QqBotEndpointCard.vue")
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
