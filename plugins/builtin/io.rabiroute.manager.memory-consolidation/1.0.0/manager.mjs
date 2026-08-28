import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.memory-consolidation@1");
        context.services.provide("manager.memory-consolidation@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        if (runtime.managerReadOnly)
            return () => { };
        const scheduler = runtime.createMemoryConsolidationScheduler();
        runtime.memoryConsolidationScheduler = scheduler;
        ctx.effect(() => async () => {
            const schedulerStopped = scheduler.stop();
            await runtime.manualTriggerProcesses.stopOwner("manager:memory-consolidation");
            await schedulerStopped;
            if (runtime.memoryConsolidationScheduler === scheduler)
                runtime.memoryConsolidationScheduler = undefined;
        }, "stop Manager memory consolidation plugin");
        if (runtime.managerListenerReady)
            scheduler.start();

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.memory-consolidation");
    }
}).activate;
