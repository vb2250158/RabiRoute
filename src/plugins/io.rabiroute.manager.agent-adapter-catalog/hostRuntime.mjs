// Plugin-owned feature construction. Shared state enters through host ports.
import { mountAgentAdapterCatalogPlugin } from "./src/manager/agentAdapterCatalog.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        mountAgentAdapterCatalogPlugin,
        getGeneration: () => ports.managerPluginKernel?.current(),
        rootDir: ports.rootDir,
        runtimes: ports.runtimes,
        get agentAdapterCatalogService() { return ports.agentAdapterCatalogService; },
        set agentAdapterCatalogService(value) { ports.agentAdapterCatalogService = value; },
    });
}
