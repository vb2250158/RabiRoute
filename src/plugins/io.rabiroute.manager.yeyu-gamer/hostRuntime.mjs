// Plugin-owned feature construction. Shared state enters through host ports.
import { createYeYuGamerManagerOperations } from "./src/integrations/yeyuGamer/managerRoutes.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        createYeYuGamerManagerOperations,
    });
}
