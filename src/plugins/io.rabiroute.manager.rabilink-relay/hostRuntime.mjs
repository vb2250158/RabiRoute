// Plugin-owned feature construction. Shared state enters through host ports.
import { RabiDirectVideo } from "./src/manager/rabiDirectVideo.js";
import { createDirectVideoOperations } from "./src/manager/rabiDirectVideoRoutes.js";
import { createRabiLinkAgentDeviceOperations } from "./src/manager/rabiLinkAgentDeviceOperations.js";
export function createOwnedRuntime(ports) {
    async function createManagerPeerRuntime(lanAgentAuthority, managerPluginRoutes) {
        const identity = ports.currentPluginActivation();
        if (!identity)
            throw new Error("Peer runtime requires its original plugin activation.");
        return ports.prepareManagerPeerRuntime({
            peer: {
                identity: () => ({ deviceId: ports.rabiLinkRelayConfigForMeta().deviceId,
                    generation: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, instanceId: ports.managerInstanceId }),
                token: () => ports.rabiLinkRelayConfigForMeta().token,
                enabled: () => ports.rabiLinkRelayConfigForMeta().enabled,
                peers: () => ports.discoverRabiPeers(ports.peerRelayConfig()), relay: () => ports.peerRelayConfig(),
                readJson: ports.readJsonBody, json: ports.jsonResponse,
                onResult: event => ports.publishManagerEvent("peer_rpc_completed", event)
            },
            tunnel: {
                readOnly: ports.managerReadOnly,
                allowApplicationConnection: () => ports.rabiLinkRelayConfigForMeta().enabled,
                allowControl: (request, url) => request.socket.localPort === ports.managerPort && (ports.hasAuthenticatedConnectionRequest(request) || ports.webguiLanRequestAllowed(request, url)),
                dataDir: ports.path.join(ports.rootDir, "data", "rabilink"),
                deviceId: ports.rabiLinkRelayConfigForMeta().deviceId,
                generation: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId,
                discover: () => ports.discoverRabiPeers(ports.peerRelayConfig()), relay: () => ports.peerRelayConfig(),
                services: () => ({ manager: { baseUrl: ports.managerBaseUrl, headers: { "x-rabilink-tunnel-local": ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId } }, speech: { baseUrl: ports.speechServiceUrl(), headers: { "x-rabilink-tunnel-local": ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId } }, resources: { baseUrl: ports.managerBaseUrl, pathPrefix: "/api/resource-cache/data", headers: { "x-rabilink-resource-key": ports.resourceCacheKey, "x-rabilink-tunnel-local": ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId } } }),
                onStatus: value => ports.publishManagerEvent("peer_tunnel_status", value)
            },
            metadata: { identity, server: ports.peerLanServer, operations: ports.createManagerApiOperationsService(managerPluginRoutes),
                refresh: () => managerPluginRoutes.refreshPublication() },
            bootstrap: {
                current: () => {
                    const config = ports.rabiLinkRelayConfigForMeta();
                    return { scope: ports.rabiLinkConnectionScope(config),
                        generation: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, deviceId: config.deviceId };
                },
                allowed: (request, url) => request.socket.localPort === ports.managerPort && (ports.hasAuthenticatedConnectionRequest(request) || ports.webguiLanRequestAllowed(request, url)),
                identity: () => ({ applicationGenerationId: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId, managerInstanceId: ports.managerInstanceId })
            },
            publication: {
                current: () => ({ tunnel: ports.activePeerTunnel, runtime: ports.activePeerRuntime }),
                set: value => { ports.activePeerTunnel = value.tunnel; ports.activePeerRuntime = value.runtime; }
            },
            admitUpgrade: (request, url) => ports.admitPeerProxyUpgrade(request, url, lanAgentAuthority)
        });
    }
    return Object.freeze({
        connection: Object.freeze({
            snapshot: () => { const relay = ports.rabiLinkRelayConfigForMeta(); return { deviceId: relay.deviceId, deviceGuid: ports.rabiGlobalConfig.read().rabiGuid, scope: ports.rabiLinkConnectionScope(relay), generation: ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId }; },
            authorize: (request) => ports.rabiLinkAgentDevicePrincipal(request, ports.rabiLinkRelayConfigForMeta(), ports.managerHostIdentity?.applicationGenerationId ?? ports.managerInstanceId),
            applicationOwnerTarget: () => ports.rabiLinkDeviceConnections.applicationTarget(),
            peers: () => ports.discoverRabiPeers(ports.peerRelayConfig())
        }),
        createPeerRuntime: () => createManagerPeerRuntime(ports.lanAgentAuthority, ports.managerPluginRoutes),
        createDirectVideoReceiver: () => new RabiDirectVideo(ports.path.join(ports.rootDir, "data", "rabilink", "video")),
        createDirectVideoOperations: (receiver) => createDirectVideoOperations(receiver, ports.managerReadOnly),
        createRabiLinkAgentDeviceOperations: () => createRabiLinkAgentDeviceOperations(() => ports.currentRabiLinkBusinessOwners().agents),
        managerPluginRoutes: ports.managerPluginRoutes,
        peerLanServer: ports.peerLanServer,
        rabiLinkRelayRuntime: ports.rabiLinkRelayRuntime,
        syncRabiLinkRelayRuntime: ports.syncRabiLinkRelayRuntime,
        get managerListenerReady() { return ports.managerListenerReady; },
        set managerListenerReady(value) { ports.managerListenerReady = value; },
        get syncActiveRabiLinkRelay() { return ports.syncActiveRabiLinkRelay; },
        set syncActiveRabiLinkRelay(value) { ports.syncActiveRabiLinkRelay = value; },
    });
}
