import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.agent-thread-control@1");
        context.services.provide("manager.agent-thread-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const owner = runtime.createAgentThreadControlOwner({
            agentRequests: runtime.agentRequests,
            messageProcessingBoard: runtime.messageProcessingBoard,
            applyManagedAgentThreadDefaults: runtime.applyManagedAgentThreadDefaults,
            agentThreadRequestOptions: runtime.agentThreadRequestOptions,
            readEndpointDeliveryOptions: runtime.readEndpointDeliveryOptions,
            getTrustedRemoteSource: runtime.getTrustedLanAgentSource,
            getTrustedDeviceSource: runtime.getTrustedDeviceSource,
            handleAgentThreadRequest: runtime.handleAgentThreadRequest,
            agentThreadRequestFailureData: runtime.agentThreadRequestFailureData,
            setMessageProcessingPlanBaseline: runtime.setMessageProcessingPlanBaseline,
            refreshAgentRequestReminderTimers: runtime.refreshAgentRequestReminderTimers,
            publishManagerEvent: runtime.publishManagerEvent,
            operationalLog: runtime.managerOperationalLog,
            operationalError: error => runtime.managerOperationalError(error, runtime.rootDir)
        });
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createAgentThreadControlOperations(owner), context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager Agent thread control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.agent-thread-control");
    }
}).activate;
