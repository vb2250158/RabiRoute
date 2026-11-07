// Plugin-owned feature construction. Shared state enters through host ports.
import { createAgentThreadControlOwner } from "./src/manager/agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "./src/manager/agentThreadControlOperations.js";
import { createPeerAgentOperations } from "./src/manager/peerAgentOperations.js";
import { createPeerRouteDeliveryOperations } from "./src/manager/peerRouteDeliveryOperations.js";
import { readCallerCreationLookup } from "@rabiroute/host-api/callerCreationMetadata";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        agentRequests: ports.agentRequests,
        agentThreadRequestFailureData: ports.agentThreadRequestFailureData,
        agentThreadRequestOptions: ports.agentThreadRequestOptions,
        getTrustedLanAgentSource: ports.getTrustedLanAgentSource,
        getTrustedDeviceSource: (request) => ports.rabiLinkAgentTaskSource(request, ports.rabiLinkRelayConfigForMeta(), ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId),
        applyManagedAgentThreadDefaults: ports.applyManagedAgentThreadDefaults,
        createAgentThreadControlOwner: (context) => createAgentThreadControlOwner({
            ...context, readCallerCreation: key => readCallerCreationLookup(ports.rootDir, key),
            forwardPeerReply: (request, guard) => ports.peerAgentBridge.forwardReply(request, guard),
            forwardPeerCallerLookup: (callerId, source, guard) => ports.peerAgentBridge.forwardCallerLookup(callerId, source, guard)
        }),
        createAgentThreadControlOperations: (owner) => [
            ...createAgentThreadControlOperations(owner), ...createPeerAgentOperations(ports.peerAgentBridge),
            ...createPeerRouteDeliveryOperations({ ...ports.peerAgentOptions,
                receiptDirectory: ports.path.join(ports.rootDir, "data", ".runtime", "peer-route-transport-receipts") })
        ],
        readEndpointDeliveryOptions: (remoteSource, requestAuthority, deviceSource) => ports.agentEndpointDelivery?.options(remoteSource, requestAuthority, deviceSource),
        handleAgentThreadRequest: ports.handleAgentThreadRequest,
        managerOperationalError: ports.managerOperationalError,
        managerOperationalLog: ports.managerOperationalLog,
        managerPluginRoutes: ports.managerPluginRoutes,
        messageProcessingBoard: ports.messageProcessingBoard,
        publishManagerEvent: ports.publishManagerEvent,
        rootDir: ports.rootDir,
        setMessageProcessingPlanBaseline: ports.setMessageProcessingPlanBaseline,
    });
}
