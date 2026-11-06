// Plugin-owned feature construction. Shared state enters through host ports.
import { createGatewayControlOperations } from "./src/manager/gatewayControlOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        managerReadOnly: ports.managerReadOnly,
        manualTriggerProcesses: ports.manualTriggerProcesses,
        stopAllGatewaysAndWait: ports.stopAllGatewaysAndWait,
        syncRunningGateways: ports.syncRunningGateways,
        acquireGatewayRuntimePluginLease: () => ports.gatewayRuntimePluginLease.acquire(),
        createGatewayListenerProjection: () => ports.listenerPublicationHost.project(),
        get managerServicesReady() { return ports.managerServicesReady; },
        set managerServicesReady(value) { ports.managerServicesReady = value; },
        createGatewayControlOperations: () => createGatewayControlOperations({
            gatewayPayload: options => ports.standaloneGatewayPayload(options?.includeDiagnostics ?? true, options?.includeConfigDefinitions ?? (options?.includeDiagnostics ?? true)),
            writeConfig: ports.writeConfig,
            writeGatewayConfig: ports.writeGatewayConfig,
            resolveRouteMutation: ports.resolveRouteMutation,
            loadRuntimes: ports.loadRuntimes,
            syncRunningGateways: ports.syncRunningGateways,
            routeMutationActivation: ports.routeMutationActivation,
            runtimeStatuses: () => [...ports.runtimes.values()].map(ports.runtimeStatus),
            networkOptionsPayload: ports.networkOptionsPayload,
            startGateway: ports.startGateway,
            stopGateway: ports.stopGateway,
            restartGateway: ports.restartGateway,
            removeGatewayConfig: ports.removeGatewayConfig,
            routeCatalogVersion: ports.routeCatalogVersion,
            weixinLoginTarget: id => {
                const runtime = ports.runtimes.get(id);
                return runtime ? { enabled: ports.sharedGatewayAdapterTypes(runtime.definition).includes("weixin"), dataDir: ports.dataDirFor(runtime.definition) } : undefined;
            },
            requestWeixinLogin: ports.requestWeixinLogin,
            triggerManualRule: (id, request) => ports.triggerGatewayManualRule(id, request, {}, "manager:gateway-runtime"),
            testAgentDelivery: ports.testGatewayAgentDelivery,
            listDeliveryReplayAttempts: ports.listGatewayDeliveryReplayAttempts,
            replayDelivery: ports.replayGatewayDelivery
        }, ports.managerReadOnly),
    });
}
