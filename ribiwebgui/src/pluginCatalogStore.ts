import { readonly, ref } from "vue";
import { pluginCatalogClient } from "./pluginCatalogClient";

const contributions = ref<readonly unknown[] | null>(null);

async function refresh(): Promise<void> {
  try {
    contributions.value = (await pluginCatalogClient.readWeb()).contributions;
  } catch {
    contributions.value = null;
  }
}

export const pluginCatalogStore = {
  contributions: readonly(contributions),
  refresh
};
