import { createPlanAgentStatusService } from "@rabiroute/host-api/manager/planAgentStatus";
// Plugin-owned feature construction. Shared state enters through host ports.
import { createRoleConfigurationOperations } from "./src/manager/roleConfigurationRoutes.js";
import { createPersonaResourceOperations } from "./src/manager/personaResourceOperations.js";
import { createPersonaPlanOperations } from "./src/manager/personaPlanOperations.js";
import { createPersonaHistoryOperations } from "./src/manager/personaHistoryOperations.js";
import { PersonaStorageOwner } from "./src/manager/personaStorageOperations.js";
import { createPersonaStorageOperations } from "./src/manager/personaStorageOperations.js";
import { createPersonaRecordingOperations } from "./src/manager/personaRecordingOperations.js";
import { createPersonaCompanionOperations } from "./src/manager/personaCompanionOperations.js";
import { createPersonaHealthOperations } from "./src/manager/personaHealthOperations.js";
import { createPersonaIdentityOperations } from "./src/manager/personaIdentityOperations.js";
import { createPersonaKnowledgeOperations } from "./src/manager/personaKnowledgeOperations.js";
import { createPersonaSkillOperations } from "./src/manager/personaSkillOperations.js";
import { createPersonaMessagingOperations } from "./src/manager/personaMessagingRoutes.js";
import { createPersonaDirectoryOperation } from "./src/manager/personaMessagingRoutes.js";
import { createLanguageStyleOperations } from "./src/manager/languageStyleRoutes.js";
import { createRolePanelOperations } from "./src/manager/rolePanelOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        ManagerPluginRequestTracker: ports.ManagerPluginRequestTracker,
        roleConfigurationOperations: createRoleConfigurationOperations({
            rolesRoot: () => ports.rolesRoot,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            routes: () => ports.readConfig().gateways,
            isReadOnly: () => ports.managerReadOnly,
            presentation: roleId => ports.routeCatalogPersonas().find(role => role.roleId === roleId && ports.path.resolve(role.rolesRoot) === ports.path.resolve(ports.rolesRoot)),
            assertCatalogReady: () => {
                if (ports.requireRouteCatalogLifecycle().snapshot().state !== "ready") {
                    throw new ports.RoleLifecycleError("ROLE_REFERENCES_UNAVAILABLE", "路由目录尚未完整加载，请稍后重试。", 503);
                }
            },
            changed: async (roleId, assertCurrent) => {
                assertCurrent();
                await ports.ensureDataDirs();
                assertCurrent();
                ports.publishManagerEvent("role_catalog_changed", { roleId });
                assertCurrent();
            }
        }),
        personaResourceOperations: createPersonaResourceOperations({
            get rolesRoot() { return ports.rolesRoot; },
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            validate: input => ports.languageStyleValidator.validate(input),
            onAvatarChanged: change => ports.publishManagerEvent("persona_avatar_changed", change)
        }),
        personaPlanOperations: createPersonaPlanOperations({
            roleDir: ports.roleDirForApi,
            service: createPlanAgentStatusService({
                readInstanceThread: async request => {
                    const body = { action: "read", ...request };
                    const result = await ports.handleAgentThreadRequest(body, ports.agentThreadRequestOptions(body));
                    if (result.statusCode < 200 || result.statusCode >= 300 || !result.data.thread) {
                        throw new Error(String(result.data.message || "Original remote plan task could not be read."));
                    }
                    return result.data.thread;
                },
                openInstanceThread: async request => {
                    const body = { action: "open", ...request };
                    const result = await ports.handleAgentThreadRequest(body, ports.agentThreadRequestOptions(body));
                    if (result.statusCode < 200 || result.statusCode >= 300) {
                        throw new Error(String(result.data.message || "Original remote plan task could not be opened."));
                    }
                }
            }),
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            send: body => ports.handleAgentThreadRequest(body, ports.agentThreadRequestOptions(body))
        }),
        personaHistoryOperations: createPersonaHistoryOperations({
            roleDir: ports.roleDirForApi,
            configuredHistoryAdapters: roleId => [...new Set(ports.routeCatalogConfig.gateways
                    .filter(route => route.agentRoleId === roleId && !route.agentRoleDeviceId)
                    .flatMap(route => (route.messageAdapters?.length ? route.messageAdapters : [route.messageAdapterType || 'napcat']).filter(type => !['disabled', 'rolePanel', 'remoteAgent', 'wearable'].includes(type))))],
            historyQqRoutes: roleId => ports.routeCatalogConfig.gateways
                .filter(route => route.agentRoleId === roleId && !route.agentRoleDeviceId && ports.sharedGatewayAdapterTypes(route).includes('napcat'))
                .map(route => ({ routeId: route.id, name: route.name || route.id, instanceId: ports.sharedNormalizeNapCatInstances(route)[0]?.id })),
            readDeliveryParties: ids => ports.readChatDeliveryParties(ports.agentRequests, ids),
            nodeName: nodeId => {
                const node = ports.lanAgentRegistry.listInstances().find(instance => instance.instanceId === nodeId);
                return node?.name || node?.hostname;
            },
            readRemoteTask: async (owner, sessionId) => {
                const instance = ports.lanAgentRegistry.listInstances().find(item => item.instanceId === owner.nodeId);
                if (!instance?.connected || instance.enabled === false)
                    return undefined;
                const result = await ports.lanAgentRegistry.manageAgent(instance.instanceId, "threads", {
                    action: "read", agentId: owner.agentId, agentAdapter: owner.provider, threadId: sessionId
                }, 1500);
                const thread = result.data?.thread;
                return result.statusCode === 200 && thread?.id === sessionId && typeof thread.title === "string"
                    ? { id: thread.id, title: thread.title } : undefined;
            },
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            queryHistory: ports.queryMessageHistory
        }),
        PersonaStorageOwner,
        createPersonaStorageOperations,
        personaStorageContext: Object.freeze(ports.createPersonaStorageOperationsContext()),
        personaRecordingOperations: createPersonaRecordingOperations({
            get runtime() { return ports.allDayRecording; },
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            local: request => ports.isLocalMachineRemoteAddress(request.socket.remoteAddress, []),
            readOnly: () => ports.managerReadOnly
        }),
        personaCompanionOperations: createPersonaCompanionOperations(ports.companionActivityContext),
        personaHealthOperations: createPersonaHealthOperations({
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            get lifecycleFence() { return ports.managerHostIdentity ? { applicationGenerationId: ports.managerHostIdentity.applicationGenerationId, managerInstanceId: ports.managerInstanceId } : null; },
            get managerPort() { return ports.managerPort; },
            deliverAlert: ports.deliverWearableAlert
        }),
        personaIdentityOperations: createPersonaIdentityOperations({
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            onEvent: (name, payload) => ports.publishManagerEvent(name, payload)
        }),
        personaKnowledgeOperations: createPersonaKnowledgeOperations({
            get service() { return ports.knowledgeSearchService; },
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            requestCatalogRefresh: ports.requestRoleKnowledgeCatalogRefresh
        }),
        personaSkillOperations: createPersonaSkillOperations({
            roleDirectory: ports.roleDirForApi,
            identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId }),
            querySkills: (directory, skillId, options) => ports.managerKnowledgePageWorkerPool.run({
                type: "role_skill_catalog", roleDir: directory, ...(skillId ? { skillId } : {})
            }, options),
            archive: (directory, skillId, outputPath, options) => ports.managerKnowledgePageWorkerPool.run({
                type: "role_skill_archive", roleDir: directory, skillId, outputPath
            }, options),
            reportCleanupError: () => console.error("[role-skill-download] Private archive cleanup failed.")
        }),
        personaMessagingOperations: createPersonaMessagingOperations(() => {
            let appendTimeline;
            try {
                const application = ports.currentRoleStorageApplication();
                appendTimeline = (roleId, message) => ports.appendRolePanelTimeline(roleId, message, application);
            }
            catch (error) {
                appendTimeline = async () => { throw error; };
            }
            return { rootDir: ports.rootDir, rolesRoot: ports.rolesRoot, personaPresentations: ports.routeCatalogPersonas, runtimes: () => [...ports.runtimes.values()],
                authorizeSource: (routeId, personaId, capability) => ports.currentPersonaMessageAuthority().verify(routeId, personaId, capability), deliver: ports.triggerGatewayRolePanelMessage, appendTimeline };
        }),
        personaDirectoryOperation: createPersonaDirectoryOperation(() => ({ rolesRoot: ports.rolesRoot, runtimes: () => [...ports.runtimes.values()], personaPresentations: ports.routeCatalogPersonas })),
        languageStyleOperations: createLanguageStyleOperations(ports.languageStyleValidator),
        rolePanelOperations: createRolePanelOperations({ runtimes: () => ports.runtimes,
            roleId: runtime => ports.roleIdForDefinition(runtime.definition),
            assertLocalOwner: runtime => ports.assertLocalPersonaOwner(runtime.definition, "Role panel messages"),
            deliver: ports.triggerGatewayRolePanelMessage,
            timelineAppender: () => { const application = ports.currentRoleStorageApplication(); return (roleId, message) => ports.appendRolePanelTimeline(roleId, message, application); },
            readMessages: (roleId, limit, signal) => ports.managerReadWorkerPool.queryRolePanelTimeline(ports.rolesRoot, roleId, limit, { signal }) }),
        languageStyleValidator: ports.languageStyleValidator,
        managerPluginRoutes: ports.managerPluginRoutes,
        registerManagerPluginHandlerRoutes: ports.registerManagerPluginHandlerRoutes,
    });
}
