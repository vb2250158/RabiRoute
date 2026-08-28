import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.diagnostics@1");
        context.services.provide("manager.diagnostics@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "runtime-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "日志诊断"
                    },
                    "routeId": "route.runtime",
                    "rendererId": "builtin.web-page.runtime.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 70
                }
            },
            {
                "kind": "navigation",
                "id": "runtime",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "日志诊断"
                    },
                    "routeId": "route.runtime",
                    "icon": "mdi-console-line",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 70
                }
            }
        ])
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
        const routes = runtime.createDiagnosticsRoutes({
            jsonResponse: runtime.jsonResponse,
            metaPayload: () => runtime.measureSyncPerformanceOperation(runtime.PERFORMANCE_OPERATIONS.managerMetaBuild, runtime.metaPayload),
            gatewayDiagnosticsPayload: () => runtime.measureSyncPerformanceOperation(runtime.PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics, () => {
                const roleInfoCatalogCache = new Map();
                const tailCache = new Map();
                // Keep the host service name distinct from each GatewayRuntime record.
                return [...runtime.runtimes.values()]
                    .map(gatewayRuntime => runtime.runtimeStatusWithRoleInfoCache(gatewayRuntime, roleInfoCatalogCache, tailCache));
            })
        });
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:diagnostics", "manager.diagnostics.api", [routes.handler], [
                { routeId: "meta", kind: "exact", path: "/meta", methods: ["GET"] },
                { routeId: "gateways", kind: "exact", path: "/api/gateways", methods: ["GET"] }
            ]);
            return async () => {
                unregister();
                await routes.stopAcceptingAndDrain();
            };
        }, "activate Manager diagnostics plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.diagnostics");
    }
}).activate;
