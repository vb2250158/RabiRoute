import { registerBuiltinMessageAdapterScanProviders } from "./src/manager/messageAdapterControl.js";
// Plugin-owned feature construction. Shared state enters through host ports.
import { MessageAdapterControlService } from "./src/manager/messageAdapterControl.js";
import { MessageAdapterScanProviderRegistry } from "./src/manager/messageAdapterControl.js";
import { createMessageAdapterControlOperations } from "./src/manager/messageAdapterControl.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        messageEndpointScanProviders: ports.messageEndpointScanProviders,
        MessageAdapterControlService,
        MessageAdapterScanProviderRegistry,
        adapterRuntimes: ports.adapterRuntimes,
        checkHttpEndpoint: ports.checkHttpEndpoint,
        createMessageAdapterControlOperations,
        managerPluginRoutes: ports.managerPluginRoutes,
        inspectEndpoint: (type, trackProbe) => ports.messageEndpointManagers.inspect(type, trackProbe),
        readGatewayStatus: ports.readGatewayStatus,
        registerBuiltinMessageAdapterScanProviders,
        remoteAgentMessageAdapterScanResult: ports.remoteAgentMessageAdapterScanResult,
        rootDir: ports.rootDir,
        routeCallbackEndpoint: ports.routeCallbackEndpoint,
        routeHasRecentMessages: ports.routeHasRecentMessages,
        speechControl: ports.speechControl,
        standaloneGatewayPayload: ports.standaloneGatewayPayload,
    });
}
