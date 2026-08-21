import { computed, readonly, ref } from "vue";
import { pluginCatalogClient, type WebPluginCatalog } from "./pluginCatalogClient";
import { availableWebContributions, type WebPluginCatalogStatus } from "./pluginContributions";
import { resolveWebCommandCatalog } from "./pluginCommands";
import { resolveWebPageCatalog } from "./pluginPages";
import { resolveWebSettingsCatalog, resolveWebStatusCatalog } from "./pluginRenderers";
import { resolveWebThemeCatalog } from "./pluginThemes";

const catalog = ref<WebPluginCatalog | null>(null);
const status = ref<WebPluginCatalogStatus>("idle");
const contributions = computed<readonly unknown[] | null>(() => (
  catalog.value ? availableWebContributions(catalog.value) : null
));
const commands = computed(() => resolveWebCommandCatalog(contributions.value));
const pages = computed(() => resolveWebPageCatalog(contributions.value, status.value));
const settingsRenderers = computed(() => resolveWebSettingsCatalog(contributions.value));
const statusRenderers = computed(() => resolveWebStatusCatalog(contributions.value));
const themes = computed(() => resolveWebThemeCatalog(contributions.value));

async function refresh(): Promise<void> {
  if (!catalog.value) status.value = "loading";
  try {
    catalog.value = await pluginCatalogClient.readWeb();
    status.value = "ready";
  } catch {
    catalog.value = null;
    status.value = "unavailable";
  }
}

export const pluginCatalogStore = {
  contributions,
  status: readonly(status),
  commands,
  pages,
  settingsRenderers,
  statusRenderers,
  themes,
  refresh
};
