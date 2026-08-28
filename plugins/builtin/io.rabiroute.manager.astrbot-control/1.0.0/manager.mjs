import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.astrbot-control@1");
        context.services.provide("manager.astrbot-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        const handler = runtime.createAgentProviderControlRouteHandler("astrbot", {
            readJsonBody: runtime.readJsonBody,
            jsonResponse: runtime.jsonResponse,
            testAstrbotLogin: runtime.testAstrbotLoginEndpoint
        }, operation => requestTracker.trackOperation(operation));
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:astrbot-control", "manager.astrbot-control.api", [requestTracker.wrap(handler)], [
                { routeId: "login-test", kind: "exact", path: "/api/agent/astrbot-login-test", methods: ["POST"] }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
            };
        }, "activate Manager AstrBot control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.astrbot-control");
    }
}).activate;
