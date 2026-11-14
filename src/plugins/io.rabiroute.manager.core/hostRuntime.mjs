// Plugin-owned feature construction. Shared state enters through host ports.
import { createComputerSettingsDefinition as createDefinition } from "./computer-settings-definition.mjs";
import { createLanAgentManagementOperations } from "./src/manager/lanAgentRoutes.js";
import { createLanAgentConnectionOperation } from "./src/manager/lanAgentConnectionOperation.js";
import { createLanAgentTerminalOperations } from "./src/manager/lanAgentTerminalRoutes.js";
import { createLanAgentComputerOperations } from "./src/manager/lanAgentComputerRoutes.js";
import { createLanAgentReadOperations } from "./src/manager/lanAgentReadOperations.js";
import { AgentResourceCatalog } from "./src/manager/agentResourceCatalog.js";
import { createResourceCacheOperations } from "./src/manager/resourceCacheOperations.js";
export function createOwnedRuntime(ports) {
    const definition = createDefinition(ports.createComputerSettingsDefinition);
    return Object.freeze({
        computerSettingsDefinition: () => definition,
        ManagerPluginRequestTracker: ports.ManagerPluginRequestTracker,
        createLanAgentManagementOperations: (context) => createLanAgentManagementOperations({...context,computerSettingsDefinition:definition}),
        createLanAgentConnectionOperation: () => createLanAgentConnectionOperation(ports.lanAgentRegistry, {
            getToken: () => ports.rabiGlobalConfig.read().webguiLan.accessToken, enabled: () => ports.rabiGlobalConfig.read().webguiLan.enabled
        }),
        createLanAgentTerminalOperations: (context) => createLanAgentTerminalOperations(context),
        createLanAgentComputerOperations: (context) => createLanAgentComputerOperations({...context,computerSettingsDefinition:definition}),
        createLanAgentReadOperations: (context) => createLanAgentReadOperations(context),
        lanAgentAuthority: ports.lanAgentAuthority,
        agentResourceCatalog: new AgentResourceCatalog({ rootDir: ports.packageRoot }),
        lanAgentManagerIdentity: () => ({
            guid: ports.rabiGlobalConfig.read().rabiGuid,
            applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId,
            managerInstanceId: ports.managerInstanceId,
            health: ports.managerHealthPayload().health
        }),
        createResourceCacheOperations: () => createResourceCacheOperations({ cache: ports.resourceCache, cacheOptions: ports.resourceCacheOptions,
            archive: ports.recordingArchiveRuntime, admin: ports.recordingArchiveAdminOptions }),
        createCorePublicOperations: () => ports.splitManagerBootstrapPublicOperations(ports.managerCorePublicOperations()).business,
        jsonResponse: ports.jsonResponse,
        lanAgentRegistry: ports.lanAgentRegistry,
        lanAgentReleaseStore: ports.lanAgentReleaseStore,
        manageLocalAgent: async (agentId, operation, body, assertAuthorized) => {
            assertAuthorized?.();
            const definition = ports.routeCatalogConfig.gateways.find(definition => ports.configuredAgentProviderTypes(definition).some(provider => `${definition.id}:${provider}` === agentId));
            if (!definition)
                throw new Error("Local Agent was not found.");
            const provider = agentId.slice(definition.id.length + 1);
            if (operation === "configure") {
                const updated = await ports.invokePublishedAgentOperation(provider, "binding.configure", {
                    definition, body
                }, { assertCurrent: assertAuthorized });
                assertAuthorized?.();
                await ports.writeGatewayConfig(definition.id, updated, String(body.configRevision || ""), ports.randomUUID());
                assertAuthorized?.();
                ports.syncRunningGateways();
                return { saved: true };
            }
            assertAuthorized?.();
            const workspace = ports.configuredLocalAgentSessionFields(definition, provider).workspace || ports.rootDir;
            const result = await ports.manageInstanceAgent(operation, { ...body, provider, agentAdapter: provider }, {
                rootDir: ports.rootDir,
                defaultWorkspace: workspace, allowedWorkspaces: [workspace],
                getProviders: () => ports.resolvePublishedAgentManagerProviders(ports.managerPluginKernel?.current()),
                invokeAgentOperation: ports.invokePublishedAgentOperation,
                dsh: definition.dshBaseUrl ? { baseUrl: definition.dshBaseUrl } : undefined
            });
            assertAuthorized?.();
            return result;
        },
        localInstanceAgents: () => ports.routeCatalogConfig.gateways.flatMap(definition => ports.configuredAgentProviderTypes(definition).map(provider => {
            const fields = ports.configuredLocalAgentSessionFields(definition, provider);
            return {
                agentId: `${definition.id}:${provider}`,
                name: fields.sessionName || definition.routeName || definition.id,
                provider: provider === "codex" ? "codex-desktop" : provider,
                enabled: (definition.agentAdapters ?? ["codex"]).includes(provider),
                routeId: definition.id,
                configRevision: ports.routeCatalogVersion().routeConfigHash,
                workspace: fields.workspace,
                sessionId: fields.sessionId,
                model: provider === "dsh" ? definition.dshModel : provider === "codex" ? definition.agentModel : undefined,
                reasoningEffort: provider === "dsh" ? definition.dshReasoningEffort : provider === "codex" ? definition.agentReasoningEffort : undefined,
                dshBaseUrl: provider === "dsh" ? definition.dshBaseUrl : undefined
            };
        })),
        managerPluginRoutes: ports.managerPluginRoutes,
        rabiGlobalConfig: ports.rabiGlobalConfig,
        readJsonBody: ports.readJsonBody,
        registerManagerPluginHandlerRoutes: ports.registerManagerPluginHandlerRoutes,
        webguiTokenMatches: ports.webguiTokenMatches,
    });
}
