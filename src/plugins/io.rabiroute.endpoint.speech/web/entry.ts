import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { registerMessageEndpointRenderer } from "../../../../ribiwebgui/src/messageEndpoints/registerMessageEndpointRenderer";
type EndpointApi = Parameters<typeof registerMessageEndpointRenderer>[0];
export function activate(api: { instanceIds: readonly string[]; forInstance(instanceId: string): EndpointApi } & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.map(instanceId => registerMessageEndpointRenderer(api.forInstance(instanceId), "speech", () => import("./messageEndpoints/SpeechEndpointCard.vue")));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
