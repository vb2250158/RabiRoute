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
        const routes = runtime.createAgentThreadControlRoutes({
            readJsonBody: runtime.readJsonBody,
            jsonResponse: runtime.jsonResponse,
            agentRequests: runtime.agentRequests,
            messageProcessingBoard: runtime.messageProcessingBoard,
            applyManagedAgentThreadDefaults: runtime.applyManagedAgentThreadDefaults,
            agentThreadRequestOptions: runtime.agentThreadRequestOptions,
            handleAgentThreadRequest: runtime.handleAgentThreadRequest,
            agentThreadRequestFailureData: runtime.agentThreadRequestFailureData,
            setMessageProcessingPlanBaseline: runtime.setMessageProcessingPlanBaseline,
            refreshAgentRequestReminderTimers: runtime.refreshAgentRequestReminderTimers,
            publishManagerEvent: runtime.publishManagerEvent,
            operationalLog: runtime.managerOperationalLog,
            operationalError: error => runtime.managerOperationalError(error, runtime.rootDir)
        });
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:agent-thread-control", "manager.agent-thread-control.api", [routes.handler], [
                { routeId: "threads", kind: "exact", path: "/api/agent/threads", methods: ["GET", "POST"] }
            ]);
            return async () => {
                unregister();
                await routes.stopAcceptingAndDrain();
            };
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
