// Plugin-owned feature construction. Shared state enters through host ports.
import { RemoteAgentHub } from "./src/messageEndpoints/remoteAgentManager.js";
import { createRemoteAgentOperations } from "./src/manager/remoteAgentRoutes.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        ManagerPluginRequestTracker: ports.ManagerPluginRequestTracker,
        RemoteAgentHub,
        appendLog: ports.appendLog,
        appendMessageContextToDir: ports.appendMessageContextToDir,
        createRemoteAgentOperations: (context) => createRemoteAgentOperations(context),
        handleRemoteAgentTaskEvent: ports.handleRemoteAgentTaskEvent,
        jsonResponse: ports.jsonResponse,
        managerHost: ports.managerHost,
        managerPluginRoutes: ports.managerPluginRoutes,
        managerPort: ports.managerPort,
        path: ports.path,
        readJsonBody: ports.readJsonBody,
        registerManagerPluginHandlerRoutes: ports.registerManagerPluginHandlerRoutes,
        remoteAgentPublicHost: ports.remoteAgentPublicHost,
        remoteAgentTaskWithGatewayDefaults: ports.remoteAgentTaskWithGatewayDefaults,
        roleDirForDefinition: ports.roleDirForDefinition,
        rootDir: ports.rootDir,
        runtimes: ports.runtimes,
        get remoteAgentHub() { return ports.remoteAgentHub; },
        set remoteAgentHub(value) { ports.remoteAgentHub = value; },
    });
}
