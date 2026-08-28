import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.performance@1");
        context.services.provide("manager.performance@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "performance-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "routeId": "global.performance",
                    "rendererId": "builtin.web-page.performance.v1",
                    "slot": "global",
                    "hosts": [
                        "web"
                    ],
                    "order": 60
                }
            },
            {
                "kind": "navigation",
                "id": "performance",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "routeId": "global.performance",
                    "icon": "mdi-chart-timeline-variant",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 60
                }
            },
            {
                "kind": "status-card",
                "id": "performance-status",
                "value": {
                    "surface": "shared.status",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "queryId": "manager.performance-status",
                    "rendererId": "builtin.performance-status.v1",
                    "icon": "mdi-chart-timeline-variant",
                    "slot": "runtime-status",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 30
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
        const recordHttpRequest = (...args) => runtime.performanceMonitoring.recordHttpRequest(...args);
        runtime.recordManagerHttpRequest = recordHttpRequest;
        const api = new runtime.PerformanceApi({
            service: runtime.performanceMonitoring,
            globalConfig: runtime.rabiGlobalConfig,
            gatewayExists: gatewayId => Boolean(runtime.runtimes.get(gatewayId)),
            readWorkerPool: runtime.managerPerformanceWorkerPool
        });
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:performance", "manager.performance.api", [
                requestTracker.wrap((request, requestUrl, response) => api.handle(request, requestUrl, response))
            ], [
                { routeId: "performance", kind: "prefix", pathPrefix: "/api/performance/" }
            ]);
            return async () => {
                unregister();
                if (runtime.recordManagerHttpRequest === recordHttpRequest)
                    runtime.recordManagerHttpRequest = () => { };
                await requestTracker.stop();
                api.close();
                await runtime.performanceMonitoring.stop();
            };
        }, "activate Manager performance plugin");
        if (!runtime.managerReadOnly)
            await runtime.performanceMonitoring.start();

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.performance");
    }
}).activate;
