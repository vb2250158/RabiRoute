import { ref } from "vue";
import type { WebPluginCatalogStatus } from "./pluginContributions";
import { refreshWebPluginModules } from "./pluginModules";

type Refresh = () => Promise<void>;
type ReportFailure = (message: string, error: unknown) => void;

const pendingRefreshes = ref(0);
const initialRefreshSettled = ref(false);

/** Reading a catalog and registering its module graph are distinct startup phases. */
export function webPluginPageLoading(status: WebPluginCatalogStatus): boolean {
  return status === "idle" || status === "loading"
    || (status === "ready" && (!initialRefreshSettled.value || pendingRefreshes.value > 0));
}

/**
 * A broken optional Web Bundle must not prevent the fixed WebGUI host from
 * rendering its recovery controls or other active Bundle pages.
 */
export async function refreshWebPluginModulesSafely(
  refresh: Refresh = refreshWebPluginModules,
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
