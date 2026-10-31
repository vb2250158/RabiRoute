import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.copilot-control@1");
        context.services.provide("manager.copilot-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const service = new runtime.CopilotControlService();
        const operations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createCopilotControlOperations({
            installCopilot: () => service.install(),
            startCopilotLogin: callbacks => service.login(callbacks),
            getCopilotStatus: () => runtime.getCopilotStatus(runtime.agentManagerApiCtx()),
            publishEvent: runtime.publishManagerEvent
        }), context.lifecycle.signal);
        ctx.effect(() => {
            return async () => {
                const retirement = operations.dispose();
                try { await service.stop(); } finally { await retirement; }
            };
        }, "activate Manager Copilot control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.copilot-control");
    }
}).activate;
