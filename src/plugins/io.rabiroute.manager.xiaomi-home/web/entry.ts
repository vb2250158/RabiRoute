import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { activateXiaomiHome } from "../../../../src/plugins/io.rabiroute.manager.xiaomi-home/web/contributions";
import { registerMessageEndpointRenderer } from "../../../../ribiwebgui/src/messageEndpoints/registerMessageEndpointRenderer";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateXiaomiHome>[0] }>;

export function activate(api: ModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.flatMap(instanceId => [
    ...activateXiaomiHome(api.forInstance(instanceId)),
    registerMessageEndpointRenderer(api.forInstance(instanceId), "xiaomiHome", () => import("./messageEndpoints/XiaomiHomeEndpointCard.vue"))
  ]);
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
