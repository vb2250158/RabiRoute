import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.bilibili-history@1");
        context.services.provide("manager.bilibili-history@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const bridge = new runtime.BilibiliHistoryBridge(runtime.path.join(runtime.rootDir, "data", "runtime", "bilibili-history-bridge.json"), () => runtime.configRepository.rolesRoot, { readOnly: runtime.managerReadOnly });
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:bilibili-history", "manager.bilibili-history.api", [
                requestTracker.wrap((request, requestUrl, response) => bridge.handle(request, requestUrl, response))
            ], [
                { routeId: "bilibili-history", kind: "prefix", pathPrefix: "/api/bilibili-history/" }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
            };
        }, "activate Manager Bilibili history plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.bilibili-history");
    }
}).activate;
