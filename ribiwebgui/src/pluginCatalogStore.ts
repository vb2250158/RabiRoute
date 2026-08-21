import { computed, readonly, ref } from "vue";
import { pluginCatalogClient, type WebPluginCatalog } from "./pluginCatalogClient";
import {
  availableWebContributions,
  resolveWebContributionVisibility,
  type WebPluginCatalogStatus
} from "./pluginContributions";
import { resolveWebPageCatalog } from "./pluginPages";
import { resolveWebThemeCatalog } from "./pluginThemes";

const catalog = ref<WebPluginCatalog | null>(null);
const status = ref<WebPluginCatalogStatus>("idle");
const contributions = computed<readonly unknown[] | null>(() => (
  catalog.value ? availableWebContributions(catalog.value) : null
));
const visibility = computed(() => resolveWebContributionVisibility(contributions.value, status.value));
const pages = computed(() => resolveWebPageCatalog(contributions.value, status.value));
const themes = computed(() => resolveWebThemeCatalog(contributions.value));

async function refresh(): Promise<void> {
  if (!catalog.value) status.value = "loading";
  try {
    catalog.value = await pluginCatalogClient.readWeb();
    status.value = "ready";
  } catch {
    if (!catalog.value) status.value = "unavailable";
  }
}

export const pluginCatalogStore = {
  contributions,
  status: readonly(status),
  visibility,
  pages,
  themes,
  refresh
};
