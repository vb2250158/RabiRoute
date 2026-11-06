// Plugin-owned feature construction. Shared state enters through host ports.
import { DesktopPetOwner } from "./src/manager/desktopPetRoutes.js";
import { createDesktopPetOperations } from "./src/manager/desktopPetOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        DesktopPetOwner,
        createDesktopPetOperations,
        desktopSettings: ports.desktopSettings,
        managerPluginRoutes: ports.managerPluginRoutes,
        publishManagerEvent: ports.publishManagerEvent,
        resolveRoleDir: ports.roleDirForApi,
    });
}
