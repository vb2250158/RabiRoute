// Plugin-owned feature construction. Shared state enters through host ports.
import { createDesktopControlOperations, desktopConfigFilePayload } from "./src/manager/desktopControlRoutes.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        adapterConfigPath: ports.adapterConfigPath,
        createDesktopControlOperations,
        desktopSettings: ports.desktopSettings,
        managerReadOnly: ports.managerReadOnly,
        publishManagerEvent: ports.publishManagerEvent,
        desktopConfigFilePayload,
        ensureDataDirs: ports.ensureDataDirs,
        ensurePersonaConfigFile: ports.ensurePersonaConfigFile,
        ensureRoleFile: ports.ensureRoleFile,
        ensureRoleFolder: ports.ensureRoleFolder,
        managerPluginRoutes: ports.managerPluginRoutes,
        rootDir: ports.rootDir,
        runtimes: ports.runtimes,
        writeAdapterConfigFile: ports.writeAdapterConfigFile,
        get rolesRoot() { return ports.rolesRoot; },
        set rolesRoot(value) { ports.rolesRoot = value; },
        get routeRoot() { return ports.routeRoot; },
        set routeRoot(value) { ports.routeRoot = value; },
    });
}
