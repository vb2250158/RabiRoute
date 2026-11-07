import { computed, readonly, ref } from "vue";
import { pluginCatalogClient, WebPluginCatalogRequestError, type WebPluginCatalog } from "./pluginCatalogClient";
import { availableWebContributions, type WebPluginCatalogStatus } from "./pluginContributions";
import { resolveWebCommandCatalog } from "./pluginCommands";
import { resolveWebPageCatalog } from "./pluginPages";
import { resolveWebSettingsCatalog, resolveWebStatusCatalog } from "./pluginRenderers";
import { resolveWebThemeCatalog } from "./pluginThemes";
import { gatewayEndpointTypesForWebCatalog } from "./messageEndpoints/messageEndpointCatalog";
import { agentAdapterCatalog } from "./agentAdapters/agentAdapterCatalog";
import { disposeWebPluginModules } from "./pluginModules";

const catalog = ref<WebPluginCatalog | null>(null);
const status = ref<WebPluginCatalogStatus>("idle");
const lastRefreshError = ref("");
let refreshSequence = 0;
const partial = computed(() => catalog.value?.partial === true);
const diagnostics = computed(() => catalog.value?.diagnostics ?? []);
const contributions = computed<readonly unknown[] | null>(() => (
  catalog.value ? availableWebContributions(catalog.value) : null
));
const commands = computed(() => resolveWebCommandCatalog(contributions.value));
const pages = computed(() => resolveWebPageCatalog(contributions.value, status.value));
const settingsRenderers = computed(() => resolveWebSettingsCatalog(contributions.value));
const gatewayEndpointTypes = computed(() => gatewayEndpointTypesForWebCatalog(catalog.value?.plugins ?? [], settingsRenderers.value));
const agentAdapters = computed(() => agentAdapterCatalog(catalog.value?.plugins ?? [], catalog.value?.contributions ?? [], settingsRenderers.value));
const statusRenderers = computed(() => resolveWebStatusCatalog(contributions.value));
const themes = computed(() => resolveWebThemeCatalog(contributions.value));

async function refresh(): Promise<void> {
  const sequence = ++refreshSequence;
  if (!catalog.value) status.value = "loading";
  try {
    const next = await pluginCatalogClient.readWeb();
    if (sequence !== refreshSequence) return;
    catalog.value = next;
    status.value = "ready";
    lastRefreshError.value = "";
  } catch (error) {
    if (sequence !== refreshSequence) return;
    const authenticationLost = error instanceof WebPluginCatalogRequestError && (error.status === 401 || error.status === 403);
    if (catalog.value && !authenticationLost) {
      // Catalog availability is distinct from the latest request outcome.
      status.value = "ready";
      lastRefreshError.value = "插件目录暂时无法刷新，正在显示上次读取的界面。";
    } else {
      catalog.value = null;
      status.value = "unavailable";
      lastRefreshError.value = "";
      if (authenticationLost) void disposeWebPluginModules().catch(error => console.error("Web plugin retirement failed after authentication was lost.", error));
    }
  }
}

export const pluginCatalogStore = {
  contributions,
  status: readonly(status),
  lastRefreshError: readonly(lastRefreshError),
  partial,
  diagnostics,
  commands,
  pages,
  settingsRenderers,
  gatewayEndpointTypes,
  agentAdapters,
  statusRenderers,
  themes,
  refresh
};
