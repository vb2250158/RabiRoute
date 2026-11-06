// Plugin-owned feature construction. Shared state enters through host ports.
import { createAgentStateReportOperations } from "./src/manager/agentStateReportOperations.js";
import { createAgentStateReportOwner } from "./src/manager/agentStateReportOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        createAgentStateReportOperations: () => createAgentStateReportOperations(createAgentStateReportOwner({
            runtime: gatewayId => ports.runtimes.get(gatewayId), states: ports.agentStateByGateway,
            writeAdapterConfigFile: ports.writeAdapterConfigFile,
            publishManagerEvent: ports.publishManagerEvent,
        })),
    });
}
