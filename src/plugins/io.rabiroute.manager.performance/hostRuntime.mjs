// Plugin-owned feature construction. Shared state enters through host ports.
import { createPerformanceOperations } from "./src/manager/performanceOperations.js";
import { PerformanceApi } from "./src/manager/performanceRoutes.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        createPerformanceOperations,
        PerformanceApi,
        managerPluginRoutes: ports.managerPluginRoutes,
        managerReadOnly: ports.managerReadOnly,
        performanceMonitoring: ports.performanceMonitoring,
        rabiGlobalConfig: ports.rabiGlobalConfig,
        runtimes: ports.runtimes,
        get recordManagerHttpRequest() { return ports.recordManagerHttpRequest; },
        set recordManagerHttpRequest(value) { ports.recordManagerHttpRequest = value; },
    });
}
