// Plugin-owned feature construction. Shared state enters through host ports.
import { createBilibiliHistoryOperations } from "./src/manager/bilibiliHistoryOperations.js";
import { BilibiliHistoryBridge } from "./src/manager/bilibiliHistoryBridge.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        createBilibiliHistoryOperations,
        BilibiliHistoryBridge,
        configRepository: ports.configRepository,
        managerPluginRoutes: ports.managerPluginRoutes,
        managerReadOnly: ports.managerReadOnly,
        path: ports.path,
        rootDir: ports.rootDir,
    });
}
