import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerMessageEndpointRenderer, type EndpointWebModuleApi } from "../../../../ribiwebgui/src/messageEndpoints/registerMessageEndpointRenderer";

export function activate(api: EndpointWebModuleApi & WebTranslationModuleApi): () => void {
  // Prepare the card with its module, rather than making the first click start another request.
  const card = import("./messageEndpoints/NapcatEndpointCard.vue");
  void card.catch(() => undefined); // The renderer retains and reports the original load failure.
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(
    api.forInstance(instanceId), "napcat", () => card
  ));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
