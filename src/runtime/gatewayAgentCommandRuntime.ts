import { resolveGatewayPluginRuntimeRoot } from "../shared/gatewayPluginRuntimeRoot.js";
import { resolvePluginPackageRoots } from "../shared/pluginPackageRoots.js";
import path from "node:path";
import { config, runtimeLayout } from "../config.js";
import { ensureAgentAdapterRuntime } from "./agentAdapterRuntime.js";
import { getBuiltinGatewayCordisRoot } from "./gatewayCordisRoot.js";
import { mountGatewayEndpointPlugins } from "./gatewayEndpointPlugins.js";
import { readGatewayRouteBootSnapshot } from "../shared/gatewayRouteSnapshotBoot.js";
/** CLI is an application entrance into the same native packages, without message subscriptions. */
export async function mountGatewayAgentCommandRuntime(): Promise<{
    dispose(): Promise<void>;
}> {
    const root = getBuiltinGatewayCordisRoot();
    const adapters = await ensureAgentAdapterRuntime(root);
    try {
        const filename = process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH?.trim() || "";
        const revision = process.env.RABIROUTE_ROUTE_REVISION?.trim() || "";
        const initialRouteDefinition = filename || revision ? readGatewayRouteBootSnapshot(filename, revision, process.env.GATEWAY_ID || "") : undefined;
        await root.ensure("rabi.runtime.agent-command.plugins", host => mountGatewayEndpointPlugins(host, {
            profilePath: process.env.RABIROUTE_PLUGIN_PROFILE?.trim() || path.join(runtimeLayout.packageRoot, "dist/plugins/profiles/desktop.json"),
            packageRoots: resolvePluginPackageRoots(runtimeLayout),
            settingsRoot: path.join(runtimeLayout.stateRoot, "data/plugins/settings"),
            stateRoot: runtimeLayout.stateRoot,
            migrationsPath: path.join(runtimeLayout.packageRoot, "dist/plugins/profiles/package-migrations.json"),
            runtimeRoot: resolveGatewayPluginRuntimeRoot(runtimeLayout, config.dataDir, "agent-command-plugins"),
            adapterTypes: [], agentsOnly: true, agentRegistry: adapters.registry, watch: false,
            ...(initialRouteDefinition ? { initialRouteDefinition, initialRouteRevision: revision } : {})
        }));
        return { dispose: () => root.dispose() };
    }
    catch (error) {
        await root.dispose();
        throw error;
    }
}
