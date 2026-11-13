import path from 'node:path';
import { webRuntimeVitePlugin as sharedRuntimePlugin } from '../../plugins/contracts/plugin-sdk/web-builder.mjs';
export { pluginWebRuntimeProxy, pluginEntryStyles } from '../../plugins/contracts/plugin-sdk/web-builder.mjs';

// Only libraries and real shared state/service owners belong here. Plugin business stays in its own package.
export const WEB_RUNTIME_MODULES = Object.freeze([
  { id: 'vue', specifier: 'vue' }, { id: 'pinia', specifier: 'pinia' }, { id: 'vue-router', specifier: 'vue-router' },
  { id: 'vuetify', specifier: 'vuetify' }, { id: 'vuetify/components', specifier: 'vuetify/components' },
  { id: 'vuetify/directives', specifier: 'vuetify/directives' },
  { id: 'rabi.i18n', source: 'ribiwebgui/src/i18n/index.ts' },
  { id: 'rabi.gateway-store', source: 'ribiwebgui/src/stores/gatewayStore.ts' },
  { id: 'rabi.manager-api', source: 'ribiwebgui/src/managerApi.ts' },
  { id: 'rabi.timeout-settings', source: 'ribiwebgui/src/timeoutSettingsClient.ts' },
  { id: 'rabi.gateway-helpers', source: 'ribiwebgui/src/utils/gatewayHelpers.ts' },
  { id: 'rabi.error-presentation', source: 'ribiwebgui/src/userFacingError.ts' },
  { id: 'rabi.page-registration', source: 'ribiwebgui/src/pluginWebContributionApi.ts' },
  { id: 'rabi.route-navigation', source: 'ribiwebgui/src/routeScopedNavigation.ts' },
  { id: 'rabi.page-save', source: 'ribiwebgui/src/pageSaveAction.ts' },
  { id: 'rabi.plugin-catalog', source: 'ribiwebgui/src/pluginCatalogStore.ts' },
  { id: 'rabi.role-store', source: 'ribiwebgui/src/stores/roleStore.ts' },
  { id: 'rabi.speech-store', source: 'ribiwebgui/src/stores/speechStore.ts' },
  { id: 'rabi.plugin-pages', source: 'ribiwebgui/src/pluginPages.ts' },
  { id: 'rabi.plugin-renderers', source: 'ribiwebgui/src/pluginRenderers.ts' },
  { id: 'rabi.plugin-themes', source: 'ribiwebgui/src/pluginThemes.ts' },
  { id: 'rabi.plugin-commands', source: 'ribiwebgui/src/pluginCommands.ts' },
  { id: 'rabi.translations', source: 'ribiwebgui/src/i18n/translationRegistry.ts' },
  { id: 'rabi.plugin-navigation', source: 'ribiwebgui/src/pluginNavigation.ts' },
  { id: 'rabi.plugin-modules', source: 'ribiwebgui/src/pluginModules.ts' }
]);
export function webRuntimeVitePlugin(root, modules = WEB_RUNTIME_MODULES) {
  return sharedRuntimePlugin(root, modules, { importer: path.join(root, 'ribiwebgui/src/main.ts') });
}
