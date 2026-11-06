import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerMessageEndpointRenderer, type EndpointWebModuleApi } from "../../../../ribiwebgui/src/messageEndpoints/registerMessageEndpointRenderer";

export function activate(api: EndpointWebModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(
    api.forInstance(instanceId), "feishu", () => import("./messageEndpoints/FeishuEndpointCard.vue")
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
