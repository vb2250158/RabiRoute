// Plugin-owned feature construction. Shared state enters through host ports.
import { createAgentCommunicationRoutes } from "./src/manager/agentCommunicationRoutes.js";
import { createApiDiscoveryOperations } from "./src/manager/apiDiscoveryRoutes.js";
import { createAgentUploadRoutes } from "./src/manager/agentUploadRoutes.js";
import { createCodexHookOperations } from "./src/manager/codexHookRoutes.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        agentRequests: ports.agentRequests,
        reconcileManagerDelivery: (deliveryId, assertCurrent) => {
            if (!ports.agentEndpointDelivery)
                throw new Error("The original delivery owner is unavailable.");
            return ports.agentEndpointDelivery.reconcileRecord(deliveryId, assertCurrent);
        },
        controlNodeDeliveryRecord: async (nodeId, input, assertCurrent) => {
            assertCurrent();
            const response = await ports.lanAgentRegistry.manageAgent(nodeId, "delivery_records", input, ports.getTimeoutMs("agent.remote.management", 10000), assertCurrent);
            assertCurrent();
            if (!response || typeof response !== "object")
                throw new Error("The original computer did not return a delivery record.");
            const value = response;
            const record = value.record ?? value.item ?? (value.id ? value : undefined);
            if (!record)
                throw new Error("Delivery record not found on the original computer.");
            return record;
        },
        readNodeDeliveryRecords: async (nodeId, query) => {
            const response = await ports.lanAgentRegistry.manageAgent(nodeId, "delivery_records", query, 10000);
            if (!response || typeof response !== "object")
                throw new Error("The original computer did not return delivery records.");
            const value = response;
            if (query.action === "get") {
                const record = value.record ?? value.item ?? (value.id ? value : undefined);
                if (!record)
                    throw new Error("Delivery record not found on the original computer.");
                return record;
            }
            const records = value.records ?? value.items;
            if (!Array.isArray(records))
                throw new Error("The original computer does not support durable delivery records yet.");
            return { records, ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
                observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
                coverage: { scope: "node", nodeId, connected: true, includesDisconnectedNodeQueues: false } };
        },
        agentSendReceiptResponse: ports.agentSendReceiptResponse,
        maintenance: Object.freeze({
            verify: (deliveryId, request, options) => ports.maintainAgentSendReceipt(deliveryId, request, options, false),
            settle: (deliveryId, request, options) => ports.maintainAgentSendReceipt(deliveryId, request, options, true)
        }),
        codexHookContextService: ports.codexHookContextService,
        createAgentCommunicationRoutes,
        createApiDiscoveryOperations: registry => [...createApiDiscoveryOperations(registry), ports.createUnifiedSearchOperation(registry)],
        readAgentChatHistory: ports.readAgentChatHistory,
        createAgentUploadRoutes: (context) => createAgentUploadRoutes({
            ...context,
            assertConnectionAuthorized: request => {
                ports.assertTrustedLanAgentPrincipal(request);
                if (!ports.hasAuthenticatedConnectionRequest(request)
                    && !ports.webguiLanRequestAllowed(request, new URL(request.url ?? "/", ports.managerBaseUrl))) {
                    throw new Error("Authenticated Manager connection is required.");
                }
            }
        }),
        agentUploadStore: ports.agentUploadStore,
        assertUploadAuthorized: ports.assertUploadAuthorized,
        findAgentSendTraces: ports.findAgentSendTraces,
        createCodexHookOperations,
        jsonResponse: ports.jsonResponse,
        managerPluginRoutes: ports.managerPluginRoutes,
        performAgentSend: (request, options = {}) => {
            const source = options.remoteSource;
            return ports.performAgentSend(request, {
                remoteSource: source,
                requestAuthority: options.requestAuthority,
                withManagedGroupFile: (fileId, expectedSha256, send) => {
                    options.requestAuthority?.();
                    return ports.agentUploadStore.withSharedFile(fileId, async (file) => {
                        options.requestAuthority?.();
                        if (file.sha256 !== expectedSha256)
                            throw new Error("Managed file content does not match the upload receipt.");
                        return send(file);
                    });
                }
            });
        },
        publishManagerEvent: ports.publishManagerEvent,
        readJsonBody: ports.readJsonBody,
        rootDir: ports.rootDir,
    });
}
