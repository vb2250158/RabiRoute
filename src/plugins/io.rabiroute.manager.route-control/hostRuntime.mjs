// Plugin-owned feature construction. Shared state enters through host ports.
import { createRabiControlOperations } from "./src/manager/rabiApiOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        createRabiControlOperations: () => createRabiControlOperations({
            rootDir: ports.rootDir,
            get routeRoot() { return ports.routeRoot; }, get managerPort() { return ports.managerPort; }, get managerHost() { return ports.managerHost; },
            applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId,
            managerInstanceId: ports.managerInstanceId,
            version: ports.rabiRoutePackageVersion, globalConfig: ports.rabiGlobalConfig,
            runtimes: () => ports.runtimes.values(),
            runtimeStatus: ports.runtimeStatus,
            readConfig: ports.readConfig,
            writeConfig: ports.writeConfig,
            loadRuntimes: ports.loadRuntimes,
            routeCatalogVersion: ports.routeCatalogVersion,
            routeCatalogPersonas: ports.routeCatalogPersonas,
            syncRunningGateways: ports.syncRunningGateways,
            syncRabiLinkRelay: () => ports.syncActiveRabiLinkRelay(),
            reconcileSpeechConfiguration: () => ports.reconcileSpeechConfiguration(),
            routeDataDir: definition => ports.dataDirFor(definition),
            scanAgentAdapters: () => {
                if (!ports.agentAdapterCatalogService)
                    throw Object.assign(new Error("Agent adapter catalog plugin is inactive."), { statusCode: 503 });
                return ports.agentAdapterCatalogService.scanAll();
            }
        }, {
            rootDir: ports.rootDir,
            get routeRoot() { return ports.routeRoot; }, get rolesRoot() { return ports.rolesRoot; },
            readManagerConfig: ports.readManagerConfig,
            writeManagerConfig: ports.writeManagerConfig,
            ensureDataDirs: ports.ensureDataDirs
        }),
    });
}
