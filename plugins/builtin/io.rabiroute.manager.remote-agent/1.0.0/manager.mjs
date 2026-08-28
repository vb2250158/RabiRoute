import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.remote-agent@1");
        context.services.provide("manager.remote-agent@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const pendingEffects = [];
            const disposers = [];
            const disposeStartedEffects = async () => {
                let firstError;
                for (const dispose of [...disposers].reverse()) {
                    try { await dispose(); } catch (error) { firstError ??= error; }
                }
                if (firstError) throw firstError;
            };
            const ctx = Object.freeze({
                effect(starter, label) {
                    const pending = Promise.resolve().then(starter).then(dispose => {
                        if (typeof dispose !== "function") throw new Error(`Plugin effect did not return a disposer: ${label ?? "effect"}.`);
                        disposers.push(dispose);
                        return dispose;
                    });
                    pendingEffects.push(pending);
                    return pending;
                }
            });
            try {
        ctx.effect(() => {
            const hub = new runtime.RemoteAgentHub({
                managerPort: runtime.managerPort,
                managerHost: runtime.managerHost,
                publicHost: runtime.remoteAgentPublicHost,
                discoveryPort: Number(process.env.REMOTE_AGENT_DISCOVERY_PORT ?? "8798"),
                passwordStorePath: runtime.path.join(runtime.rootDir, "data", "remote-agent-connections.json"),
                fileStoreDir: runtime.path.join(runtime.rootDir, "data", "remote-agent-files"),
                getDefaultGatewayId: () => [...runtime.runtimes.values()][0]?.definition.id,
                onTaskEvent: runtime.handleRemoteAgentTaskEvent,
                onConversationRecord: (record, signal) => {
                    if (signal.aborted)
                        return;
                    const runtime = record.gatewayId ? runtime.runtimes.get(record.gatewayId) : undefined;
                    if (!runtime) {
                        console.warn(`Remote Agent conversation record skipped: Gateway not found (${record.gatewayId || "missing"})`);
                        return;
                    }
                    try {
                        runtime.appendMessageContextToDir(runtime.roleDirForDefinition(runtime.definition), record);
                    }
                    catch (error) {
                        runtime.appendLog(runtime, `remote agent conversation record failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            });
            const requestTracker = new runtime.ManagerPluginRequestTracker();
            runtime.remoteAgentHub = hub;
            const unregisterRoutes = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:remote-agent", "manager.remote-agent.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleRemoteAgentPluginApi(request, requestUrl, response, {
                    readJsonBody: runtime.readJsonBody,
                    jsonResponse: runtime.jsonResponse,
                    listDevices: () => hub.listDevices(),
                    listTasks: limit => hub.listTasks(limit),
                    scanLan: () => hub.scanLan(),
                    connectDevice: body => hub.connectDevice(body),
                    disconnectDevice: deviceId => hub.disconnectDevice(deviceId),
                    createTask: body => hub.createTask(body),
                    receiveTaskEvent: event => hub.receiveTaskEvent(event),
                    applyTaskDefaults: runtime.remoteAgentTaskWithGatewayDefaults,
                    trackOperation: operation => requestTracker.trackOperation(operation)
                }))
            ], [
                { routeId: "devices", kind: "exact", path: "/api/remote-agent/devices", methods: ["GET"] },
                { routeId: "scan", kind: "exact", path: "/api/remote-agent/scan", methods: ["POST"] },
                { routeId: "connect", kind: "exact", path: "/api/remote-agent/connect", methods: ["POST"] },
                { routeId: "disconnect", kind: "exact", path: "/api/remote-agent/disconnect", methods: ["POST"] },
                { routeId: "tasks", kind: "exact", path: "/api/remote-agent/tasks", methods: ["GET", "POST"] },
                { routeId: "task-events", kind: "exact", path: "/api/remote-agent/task-events", methods: ["POST"] }
            ]);
            return async () => {
                unregisterRoutes();
                hub.stopAccepting();
                await requestTracker.stop();
                if (runtime.remoteAgentHub === hub)
                    runtime.remoteAgentHub = undefined;
                await hub.shutdown();
            };
        }, "activate Manager Remote Agent plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.remote-agent");
    }
}).activate;
