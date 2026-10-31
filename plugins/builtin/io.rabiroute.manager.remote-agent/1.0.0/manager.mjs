import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
    activate(context) {
        const runtime = context.services.require("host.manager.remote-agent@1");
        context.services.provide("manager.remote-agent@1", Object.freeze({ instanceId: context.identity.instanceId }));
        let hub;
        let registration;
        let previousHub;
        let disposal;
        const stopOwner = () => disposal ??= (async () => {
            const failures = [];
            try { hub?.stopAccepting(); } catch (error) { failures.push(error); }
            try { await registration?.dispose(); } catch (error) { failures.push(error); }
            try { await hub?.shutdown(); } catch (error) { failures.push(error); }
            if (failures.length) throw new AggregateError(failures, "Manager Remote Agent owner cleanup failed.");
        })();

        context.effects.add(async () => {
            // Construction only retains options; no discovery, connection or task starts here.
            hub = new runtime.RemoteAgentHub({
                managerPort: runtime.managerPort,
                managerHost: runtime.managerHost,
                publicHost: runtime.remoteAgentPublicHost,
                discoveryPort: Number(process.env.REMOTE_AGENT_DISCOVERY_PORT ?? "8798"),
                passwordStorePath: runtime.path.join(runtime.rootDir, "data", "remote-agent-connections.json"),
                fileStoreDir: runtime.path.join(runtime.rootDir, "data", "remote-agent-files"),
                getDefaultGatewayId: () => [...runtime.runtimes.values()][0]?.definition.id,
                onTaskEvent: runtime.handleRemoteAgentTaskEvent,
                onConversationRecord: (record, signal) => {
                    if (signal.aborted) return;
                    const gatewayRuntime = record.gatewayId ? runtime.runtimes.get(record.gatewayId) : undefined;
                    if (!gatewayRuntime) {
                        console.warn("Remote Agent conversation record skipped: Gateway not found (" + (record.gatewayId || "missing") + ")");
                        return;
                    }
                    try {
                        runtime.appendMessageContextToDir(runtime.roleDirForDefinition(gatewayRuntime.definition), record);
                    } catch (error) {
                        runtime.appendLog(gatewayRuntime, "remote agent conversation record failed: " + (error instanceof Error ? error.message : String(error)));
                    }
                }
            });
            // Adopt before registration so a registration failure still joins this private hub.
            context.effects.adopt(stopOwner, "prepared Manager Remote Agent hub");
            registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createRemoteAgentOperations({
                listDevices: () => hub.listDevices(),
                listTasks: limit => hub.listTasks(limit),
                scanLan: guard => hub.scanLan(undefined, guard),
                connectDevice: (body, guard) => hub.connectDevice(body, guard),
                disconnectDevice: (deviceId, guard) => hub.disconnectDevice(deviceId, guard),
                createTask: (body, guard) => hub.createTask(body, guard),
                receiveTaskEvent: (event, guard) => hub.receiveTaskEvent(event, undefined, guard),
                applyTaskDefaults: runtime.remoteAgentTaskWithGatewayDefaults
            }), context.lifecycle.signal);
            return stopOwner;
        }, "prepare Manager Remote Agent hub");

        context.publication.add({
            publish() {
                if (!hub) throw new Error("Manager Remote Agent hub was not prepared.");
                previousHub = runtime.remoteAgentHub;
                runtime.remoteAgentHub = hub;
            },
            rollback() {
                if (runtime.remoteAgentHub === hub) runtime.remoteAgentHub = previousHub;
            },
            async retire() {
                if (runtime.remoteAgentHub === hub) runtime.remoteAgentHub = undefined;
                await stopOwner();
            }
        }, "Manager Remote Agent hub owner");
    }
}).activate;
