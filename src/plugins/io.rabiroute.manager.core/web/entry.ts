import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { activateCore } from "../../../../src/plugins/io.rabiroute.manager.core/web/contributions";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateCore>[0] }>;

export function activate(api: ModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.flatMap(instanceId => activateCore(api.forInstance(instanceId)));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
