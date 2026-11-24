import { ref } from "vue";
import type { WebPluginCatalogStatus } from "./pluginContributions";
import { refreshWebPluginModules, webPluginModulesPending } from "./pluginModules";
import { pluginCatalogStore } from "./pluginCatalogStore";

type Refresh = () => Promise<void>;
type ReportFailure = (message: string, error: unknown) => void;

const pendingRefreshes = ref(0);
const initialRefreshSettled = ref(false);
let catalogFlight: Promise<void> | undefined;
let catalogChangedDuringRead = false;

export function refreshWebPluginCatalog(catalogChanged = false): Promise<void> {
  if (catalogFlight) {
    catalogChangedDuringRead ||= catalogChanged;
    return catalogFlight;
  }
  catalogFlight = (async () => {
    do {
      catalogChangedDuringRead = false;
      await pluginCatalogStore.refresh();
      if (pluginCatalogStore.status.value === "ready") await refreshWebPluginModulesSafely();
    } while (catalogChangedDuringRead);
  })().finally(() => { catalogFlight = undefined; });
  return catalogFlight;
}

/** Reading a catalog and registering its module graph are distinct startup phases. */
export function webPluginPageLoading(status: WebPluginCatalogStatus): boolean {
  return status === "idle" || status === "loading"
    || (status === "ready" && (!initialRefreshSettled.value || pendingRefreshes.value > 0 || webPluginModulesPending()));
}

/**
 * A broken optional Web Bundle must not prevent the fixed WebGUI host from
 * rendering its recovery controls or other active Bundle pages.
 */
export async function refreshWebPluginModulesSafely(
  refresh: Refresh = () => refreshWebPluginModules({ initialization: "background" }),
  reportFailure: ReportFailure = (message, error) => console.error(message, error)
): Promise<boolean> {
  pendingRefreshes.value++;
  try {
    await refresh();
    return true;
  } catch (error) {
    reportFailure("Web plugin module refresh failed; the fixed WebGUI host remains available.", error);
    return false;
  } finally {
    pendingRefreshes.value--;
    initialRefreshSettled.value = true;
  }
}
