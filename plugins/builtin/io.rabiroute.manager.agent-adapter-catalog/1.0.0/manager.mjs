import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.agent-adapter-catalog@1");
        context.services.provide("manager.agent-adapter-catalog@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const mount = runtime.mountAgentAdapterCatalogPlugin({
            rootDir: runtime.rootDir,
            getRuntimes: () => runtime.runtimes.values(),
            jsonResponse: runtime.jsonResponse,
            registerRoutes: (instanceId, routeIdPrefix, handlers) => runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, instanceId, routeIdPrefix, handlers, [
                { routeId: "catalog", kind: "exact", path: "/api/agent-adapters/catalog", methods: ["GET"] },
                { routeId: "scan-agents", kind: "exact", path: "/api/scan/agents", methods: ["GET"] },
                { routeId: "scan-dsh", kind: "exact", path: "/api/scan/agents/dsh", methods: ["GET"] }
            ])
        });
        runtime.agentAdapterCatalogService = mount.service;
        ctx.effect(() => async () => {
            if (runtime.agentAdapterCatalogService === mount.service)
                runtime.agentAdapterCatalogService = undefined;
            await mount.stop("Manager Agent adapter catalog plugin stopped.");
        }, "stop Manager Agent adapter catalog plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.agent-adapter-catalog");
    }
}).activate;
