import type { WebTranslationModuleApi } from "../../../../ribiwebgui/src/i18n/translationRegistry";
import { pluginTranslations } from "./translations";
import { activateDiagnostics } from "../../../../src/plugins/io.rabiroute.manager.diagnostics/web/contributions";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateDiagnostics>[0] }>;

export function activate(api: ModuleApi & WebTranslationModuleApi): () => void {
  const disposeTranslations = api.registerTranslations(pluginTranslations);
  const disposers = api.instanceIds.flatMap(instanceId => activateDiagnostics(api.forInstance(instanceId)));
  disposers.unshift(disposeTranslations);
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
