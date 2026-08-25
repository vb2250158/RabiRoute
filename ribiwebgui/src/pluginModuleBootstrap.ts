import { refreshWebPluginModules } from "./pluginModules";

type Refresh = () => Promise<void>;
type ReportFailure = (message: string, error: unknown) => void;

/**
 * A broken optional Web Bundle must not prevent the fixed WebGUI host from
 * rendering its recovery controls or other active Bundle pages.
 */
export async function refreshWebPluginModulesSafely(
  refresh: Refresh = refreshWebPluginModules,
  reportFailure: ReportFailure = (message, error) => console.error(message, error)
): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (error) {
    reportFailure("Web plugin module refresh failed; the fixed WebGUI host remains available.", error);
    return false;
  }
}
